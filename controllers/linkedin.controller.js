import crypto from "crypto";
import axios from "axios";
import { getTenantModels } from "../models/tenant/index.js";
import LinkedInMapping from "../models/master/LinkedInMapping.js";
import LinkedInWebhookLog from "../models/master/LinkedInWebhookLog.js";
import Tenant from "../models/master/Tenant.js";
import { getTenantDB } from "../config/tenantDB.js";
import { isFeatureEnabled } from "../utils/planFeatures.js";

const LINKEDIN_API = "https://api.linkedin.com/v2";

// ─── AES-256-GCM Encryption Helpers ──────────────────────────────────────────

const getEncryptionKey = () => {
  const secret = process.env.LINKEDIN_ENCRYPTION_KEY || process.env.SECRET_KEY || process.env.JWT_SECRET || "fallback_secret_32_bytes_long!!!!!";
  return crypto.createHash("sha256").update(secret).digest();
};

const encrypt = (text) => {
  if (!text) return "";
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${encrypted}:${tag}`;
};

const decrypt = (encryptedText) => {
  if (!encryptedText) return "";
  try {
    const key = getEncryptionKey();
    const [ivHex, encrypted, tagHex] = encryptedText.split(":");
    if (!ivHex || !encrypted || !tagHex) return "";
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (err) {
    console.error("LinkedIn decryption failure:", err.message);
    return "";
  }
};

// ─── Controllers ─────────────────────────────────────────────────────────────

export default {
  /**
   * GET /:tenantSlug/api/linkedin/auth-url
   * Generate encrypted state & LinkedIn OAuth URL
   */
  getAuthUrl: (req, res) => {
    try {
      const clientId = process.env.LINKEDIN_CLIENT_ID;
      const redirectUri = process.env.LINKEDIN_REDIRECT_URI;
      if (!clientId || !redirectUri) {
        return res.status(500).json({ success: false, message: "LINKEDIN_CLIENT_ID or LINKEDIN_REDIRECT_URI not configured in .env" });
      }

      const scopes = ["openid", "profile", "email", "r_ads", "rw_ads", "r_organization_admin"].join(" ");

      const stateObj = {
        tenantId: req.tenant._id.toString(),
        tenantSlug: req.tenant.slug,
        userId: req.user._id.toString(),
        expiry: Date.now() + 15 * 60 * 1000, // 15 mins expiry
      };

      const encryptedState = encrypt(JSON.stringify(stateObj));

      const authUrl = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(encryptedState)}&scope=${encodeURIComponent(scopes)}`;

      res.json({ success: true, authUrl });
    } catch (err) {
      console.error("LinkedIn getAuthUrl error:", err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  },

  /**
   * GET /:tenantSlug/api/linkedin/forms
   * Fetch lead forms for a selected Ad Account from LinkedIn API
   */
  fetchForms: async (req, res) => {
    try {
      const { adAccountUrn, accessTokenEncrypted } = req.query;
      if (!adAccountUrn || !accessTokenEncrypted) {
        return res.status(400).json({ success: false, message: "adAccountUrn and accessTokenEncrypted are required" });
      }

      const token = decrypt(accessTokenEncrypted);

      const formsRes = await axios.get(`${LINKEDIN_API}/adFormsV2`, {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          q: "account",
          account: adAccountUrn,
        },
      });

      const forms = (formsRes.data.elements || []).map(f => ({
        urn: `urn:li:adForm:${f.id}`,
        name: f.name || `Lead Form ${f.id}`,
      }));

      res.json({ success: true, forms });
    } catch (err) {
      console.error("LinkedIn fetchForms error:", err.response?.data || err.message);
      res.status(500).json({ success: false, message: err.response?.data?.message || err.message });
    }
  },

  /**
   * GET /:tenantSlug/api/linkedin/callback
   * Exchange code, fetch user details, organizations, and ad accounts.
   */
  handleCallback: async (req, res) => {
    try {
      console.log("LinkedIn callback query:", req.query);
      const { code, state } = req.query;
      if (!code || !state) {
        return res.status(400).json({ success: false, message: "Authorization code and state are required" });
      }

      // 1. Decrypt and validate state
      let stateObj;
      try {
        const decrypted = decrypt(state);
        stateObj = JSON.parse(decrypted);
      } catch (err) {
        return res.status(400).json({ success: false, message: "Invalid or tampered state" });
      }

      if (Date.now() > stateObj.expiry) {
        return res.status(400).json({ success: false, message: "OAuth state has expired" });
      }

      const clientId = process.env.LINKEDIN_CLIENT_ID;
      const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
      const redirectUri = process.env.LINKEDIN_REDIRECT_URI;

      if (!clientId || !clientSecret || !redirectUri) {
        return res.status(500).json({ success: false, message: "LinkedIn client credentials or redirect URI not configured in .env" });
      }

      console.log("LinkedIn OAuth Audit:");
      console.log(`- LINKEDIN_CLIENT_ID: length=${clientId.length}, value=${clientId.slice(0, 5)}...${clientId.slice(-5)}`);
      console.log(`- LINKEDIN_CLIENT_SECRET: length=${clientSecret.length}, value=${clientSecret.slice(0, 5)}...${clientSecret.slice(-5)}`);
      console.log(`- LINKEDIN_REDIRECT_URI: ${redirectUri}`);
      console.log(`- code: ${code}`);

      // Generate exact curl command for manual testing
      const curlCommand = `curl -X POST https://www.linkedin.com/oauth/v2/accessToken \\
  -H "Content-Type: application/x-www-form-urlencoded" \\
  -d "grant_type=authorization_code" \\
  -d "code=${code}" \\
  -d "redirect_uri=${redirectUri}" \\
  -d "client_id=${clientId}" \\
  -d "client_secret=${clientSecret}"`;
      console.log("Equivalent Curl Command:\n", curlCommand);

      // 2. Exchange code for access token
      const tokenRes = await axios.post(
        "https://www.linkedin.com/oauth/v2/accessToken",
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          client_secret: clientSecret,
        }),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );

      const { access_token, expires_in, refresh_token } = tokenRes.data;

      // 3. Fetch User Profile using OpenID Connect endpoint
      let memberId = "unknown";
      let profileName = "LinkedIn User";
      try {
        const profileRes = await axios.get("https://api.linkedin.com/v2/userinfo", {
          headers: { Authorization: `Bearer ${access_token}` },
        });
        memberId = profileRes.data.sub;
        profileName = profileRes.data.name || `${profileRes.data.given_name} ${profileRes.data.family_name}`;
      } catch (pErr) {
        console.warn("LinkedIn userinfo fetch failed, trying fallback /v2/me", pErr.message);
        try {
          const fallbackRes = await axios.get(`${LINKEDIN_API}/me`, {
            headers: { Authorization: `Bearer ${access_token}` },
          });
          memberId = fallbackRes.data.id;
          profileName = `${fallbackRes.data.localizedFirstName} ${fallbackRes.data.localizedLastName}`;
        } catch (fErr) {
          console.error("LinkedIn profile fallback failed:", fErr.message);
        }
      }

      // Find tenant by slug to get correct dbName
      const tenantObj = await Tenant.findOne({ slug: stateObj.tenantSlug });
      if (!tenantObj) {
        return res.status(404).json({ success: false, message: `Tenant not found for slug: ${stateObj.tenantSlug}` });
      }

      // Save integration data into tenant database
      const db = await getTenantDB(tenantObj.dbName);
      if (!db.modelNames().includes("LinkedInIntegration")) {
        const { default: schema } = await import("../models/schemas/linkedinIntegrationSchema.js");
        db.model("LinkedInIntegration", schema);
      }
      const { LinkedInIntegration } = getTenantModels(db);
      const expiresAt = expires_in ? new Date(Date.now() + expires_in * 1000) : null;

      // Update existing active integrations with new token, do NOT upsert/create a blank one
      await LinkedInIntegration.updateMany(
        { linkedinMemberId: memberId, status: "active" },
        {
          accessToken: encrypt(access_token),
          expiresAt,
        }
      );

      // 4. Fetch Organizations
      let organizations = [];
      try {
        const orgRes = await axios.get(`${LINKEDIN_API}/organizationalEntityAcls?q=roleAssignee&role=ADMINISTRATOR`, {
          headers: { Authorization: `Bearer ${access_token}` },
        });
        const aclList = orgRes.data.elements || [];
        for (const acl of aclList) {
          const urn = acl.organizationalEntity;
          const orgDetails = await axios.get(`${LINKEDIN_API}/organizations/${urn.split(":").pop()}`, {
            headers: { Authorization: `Bearer ${access_token}` },
          });
          organizations.push({
            urn,
            name: orgDetails.data.localizedName || urn,
          });
        }
      } catch (orgErr) {
        console.warn("LinkedIn organizations fetch failed:", orgErr.message);
      }

      // 5. Fetch Ad Accounts
      let adAccounts = [];
      try {
        const adsRes = await axios.get(`${LINKEDIN_API}/adAccountsV2?q=search&search=(status:(values:(ACTIVE)))`, {
          headers: { Authorization: `Bearer ${access_token}` },
        });
        adAccounts = (adsRes.data.elements || []).map(ad => ({
          urn: `urn:li:sponsorAccount:${ad.id}`,
          name: ad.name || `Ad Account ${ad.id}`,
        }));
      } catch (adsErr) {
        console.warn("LinkedIn ad accounts fetch failed:", adsErr.message);
      }

      res.json({
        success: true,
        accessTokenEncrypted: encrypt(access_token),
        refreshTokenEncrypted: refresh_token ? encrypt(refresh_token) : "",
        expiresIn: expires_in,
        memberId,
        profileName,
        organizations,
        adAccounts,
        integration: null,
      });
    } catch (err) {
      console.error("LinkedIn Callback exchange error:", err.response?.data || err.message);
      res.status(500).json({ success: false, message: err.response?.data?.error_description || err.message });
    }
  },

  /**
   * POST /:tenantSlug/api/linkedin/connect
   * Connect and save LinkedIn settings. Create Mapping entry.
   */
  connect: async (req, res) => {
    try {
      const {
        memberId,
        organizationUrn,
        organizationName,
        adAccountUrn,
        adAccountName,
        leadFormUrn,
        leadFormName,
        accessTokenEncrypted,
        refreshTokenEncrypted,
        expiresIn,
      } = req.body;

      if (!leadFormUrn || !accessTokenEncrypted) {
        return res.status(400).json({ success: false, message: "Lead Form URN and access tokens are required." });
      }

      // Decrypt to make sure they are valid, then re-encrypt/store them
      const rawToken = decrypt(accessTokenEncrypted);
      const rawRefresh = decrypt(refreshTokenEncrypted);

      const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;

      const { LinkedInIntegration } = getTenantModels(req.tenantDB);

      // Save to tenant database
      const integration = await LinkedInIntegration.findOneAndUpdate(
        { leadFormUrn },
        {
          tenantId: req.tenant._id,
          linkedinMemberId: memberId,
          organizationUrn,
          organizationName,
          adAccountUrn,
          adAccountName,
          leadFormUrn,
          leadFormName,
          accessToken: encrypt(rawToken),
          refreshToken: rawRefresh ? encrypt(rawRefresh) : "",
          expiresAt,
          webhookSubscribed: true,
          status: "active",
          connectedBy: req.user._id,
        },
        { upsert: true, new: true }
      );

      // Create Mapping entry in master DB for webhook router lookup
      await LinkedInMapping.findOneAndUpdate(
        { leadFormUrn },
        {
          tenantId: req.tenant._id,
          dbName: req.tenant.dbName,
          integrationId: integration._id,
          leadFormUrn,
          organizationUrn,
          adAccountUrn,
        },
        { upsert: true }
      );

      res.json({ success: true, message: `LinkedIn Form "${leadFormName}" connected successfully!`, integration });
    } catch (err) {
      console.error("LinkedIn Connect error:", err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  },

  /**
   * GET /:tenantSlug/api/linkedin/integrations
   */
  getIntegrations: async (req, res) => {
    try {
      const { LinkedInIntegration } = getTenantModels(req.tenantDB);
      const list = await LinkedInIntegration.find({ status: "active", leadFormUrn: { $ne: "" } })
        .populate("connectedBy", "firstName lastName email")
        .sort({ createdAt: -1 });

      res.json({ success: true, data: list });
    } catch (err) {
      console.error("LinkedIn getIntegrations error:", err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  },

  /**
   * POST /:tenantSlug/api/linkedin/disconnect
   */
  disconnect: async (req, res) => {
    try {
      const { leadFormUrn } = req.body;
      if (!leadFormUrn) {
        return res.status(400).json({ success: false, message: "leadFormUrn is required" });
      }

      const { LinkedInIntegration } = getTenantModels(req.tenantDB);

      const integration = await LinkedInIntegration.findOneAndUpdate(
        { leadFormUrn },
        { status: "disconnected", webhookSubscribed: false },
        { new: true }
      );

      if (!integration) {
        return res.status(404).json({ success: false, message: "Integration not found" });
      }

      // Remove from central mapping lookup
      await LinkedInMapping.deleteOne({ leadFormUrn });

      res.json({ success: true, message: "LinkedIn Integration disconnected successfully" });
    } catch (err) {
      console.error("LinkedIn disconnect error:", err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  },

  /**
   * POST /:tenantSlug/api/linkedin/sync-leads
   * Manual lead sync
   */
  syncLeads: async (req, res) => {
    console.log("========== SYNC LEADS START ==========");
    console.log(req.body);
    try {
      const { leadFormUrn } = req.body;
      if (!leadFormUrn) {
        return res.status(400).json({ success: false, message: "leadFormUrn is required" });
      }

      const { LinkedInIntegration, Lead } = getTenantModels(req.tenantDB);
      const integration = await LinkedInIntegration.findOne({ leadFormUrn, status: "active" });

      if (!integration) {
        return res.status(404).json({ success: false, message: "Active integration not found for this form" });
      }

      const token = decrypt(integration.accessToken);

      // Fetch lead responses from LinkedIn adFormResponses API
      // Query: GET /v2/adFormResponses?q=form&form={leadFormUrn}
      const response = await axios.get(`${LINKEDIN_API}/adFormResponses`, {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          q: "form",
          form: leadFormUrn,
        },
      });

      const elements = response.data.elements || [];
      let imported = 0;
      let skippedDuplicates = 0;
      let failed = 0;

      for (const element of elements) {
        try {
          const linkedinLeadId = element.id;

          // Deduplication
          const existing = await Lead.findOne({ linkedinLeadId });
          if (existing) {
            skippedDuplicates++;
            continue;
          }

          // Parse responses
          const fieldMap = {};
          (element.questionResponses || []).forEach(q => {
            fieldMap[q.questionUserLabel] = q.inputValue || "";
          });

          // Fetch campaign details if available
          let campaignName = "LinkedIn Campaign";
          if (element.campaign) {
            try {
              const campRes = await axios.get(`${LINKEDIN_API}/adCampaignsV2/${element.campaign.split(":").pop()}`, {
                headers: { Authorization: `Bearer ${token}` },
              });
              campaignName = campRes.data.name || campaignName;
            } catch (cErr) {
              console.warn("Could not fetch campaign name:", cErr.message);
            }
          }

          await Lead.create({
            leadName: fieldMap["First Name"] && fieldMap["Last Name"] ? `${fieldMap["First Name"]} ${fieldMap["Last Name"]}` : fieldMap["Full Name"] || "LinkedIn Lead",
            email: fieldMap["Email Address"] || fieldMap["Email"] || "",
            phoneNumber: fieldMap["Phone Number"] || fieldMap["Phone"] || "N/A",
            companyName: fieldMap["Company Name"] || fieldMap["Company"] || integration.organizationName || "LinkedIn Org",
            source: "LinkedIn",
            status: "Cold",
            linkedinLeadId,
            linkedinCampaignId: element.campaign || "",
            linkedinCampaignName: campaignName,
            linkedinFormId: integration.leadFormUrn,
            linkedinFormName: integration.leadFormName,
            notes: `Manually synced from LinkedIn Lead Gen Form: ${integration.leadFormName}`,
          });

          imported++;
        } catch (itemErr) {
          console.error("Failed to sync lead element:", itemErr.message);
          failed++;
        }
      }

      res.json({
        success: true,
        imported,
        skippedDuplicates,
        failed,
      });
    } catch (err) {
      console.error("LinkedIn Manual syncLeads error:", err.response?.data || err.message);
      res.status(err.response?.status || 500).json({ 
        success: false, 
        message: err.response?.data?.message || err.message 
      });
    }
  },
};

// ─── Webhook Lead Gen Processing (Public) ────────────────────────────────────

export const processLinkedInLeadWebhook = async (req, res) => {
  const payload = req.body;

  // Webhook Security Signature Check
  const signature = req.headers["x-li-signature"];
  const webhookSecret = process.env.LINKEDIN_WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(payload));
    const hmac = crypto.createHmac("sha256", webhookSecret);
    hmac.update(rawBody);
    const expectedSignature = hmac.digest("hex");
    if (signature !== expectedSignature) {
      console.warn("❌ LinkedIn Webhook Signature mismatch");
      await LinkedInWebhookLog.create({
        payload,
        status: "failed",
        error: "Signature mismatch verification failure",
      });
      return res.status(403).send("Forbidden");
    }
  }

  // Acknowledge receipt of the webhook to LinkedIn immediately
  res.status(200).send("EVENT_RECEIVED");

  try {
    // LinkedIn Lead Event payload contains the adFormResponse URN and form URN
    // Expected fields: leadFormUrn, adFormResponseUrn, etc.
    const { leadFormUrn, adFormResponseUrn } = payload;
    if (!leadFormUrn || !adFormResponseUrn) {
      await LinkedInWebhookLog.create({
        payload,
        status: "ignored",
        error: "Missing leadFormUrn or adFormResponseUrn in event",
      });
      return;
    }

    // 1. Look up mapping in master DB
    const mapping = await LinkedInMapping.findOne({ leadFormUrn });
    if (!mapping) {
      await LinkedInWebhookLog.create({
        payload,
        leadFormUrn,
        status: "ignored",
        error: "No tenant mapping found for this leadFormUrn",
      });
      return;
    }

    // 2. Fetch tenant DB and models
    const db = await getTenantDB(mapping.dbName);
    const { LinkedInIntegration, Lead } = getTenantModels(db);

    const integration = await LinkedInIntegration.findOne({ leadFormUrn, status: "active" });
    if (!integration) {
      await LinkedInWebhookLog.create({
        payload,
        leadFormUrn,
        status: "failed",
        error: "Tenant integration inactive or not found",
      });
      return;
    }

    // The tenant may have connected LinkedIn before their plan dropped this
    // integration — stop ingesting leads for them going forward.
    const tenantMaster = await Tenant.findOne({ dbName: mapping.dbName }).populate("plan_id");
    if (!isFeatureEnabled(tenantMaster?.plan_id?.features, "integration_linkedin")) {
      await LinkedInWebhookLog.create({
        payload,
        leadFormUrn,
        status: "ignored",
        error: "integration_linkedin disabled on tenant's plan",
      });
      return;
    }

    const token = decrypt(integration.accessToken);
    const responseId = adFormResponseUrn.split(":").pop();

    // 3. Fetch Lead Details from LinkedIn
    const leadDetailsRes = await axios.get(`${LINKEDIN_API}/adFormResponses/${responseId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const leadData = leadDetailsRes.data;
    const linkedinLeadId = leadData.id;

    // Deduplication check
    const existing = await Lead.findOne({ linkedinLeadId });
    if (existing) {
      await LinkedInWebhookLog.create({
        payload,
        leadFormUrn,
        status: "ignored",
        error: `Duplicate lead received: ${linkedinLeadId}`,
      });
      return;
    }

    // Parse responses
    const fieldMap = {};
    (leadData.questionResponses || []).forEach(q => {
      fieldMap[q.questionUserLabel] = q.inputValue || "";
    });

    let campaignName = "LinkedIn Campaign";
    if (leadData.campaign) {
      try {
        const campRes = await axios.get(`${LINKEDIN_API}/adCampaignsV2/${leadData.campaign.split(":").pop()}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        campaignName = campRes.data.name || campaignName;
      } catch (cErr) {
        console.warn("Could not fetch campaign name in webhook:", cErr.message);
      }
    }

    // 4. Create Lead in Tenant's DB
    await Lead.create({
      leadName: fieldMap["First Name"] && fieldMap["Last Name"] ? `${fieldMap["First Name"]} ${fieldMap["Last Name"]}` : fieldMap["Full Name"] || "LinkedIn Lead",
      email: fieldMap["Email Address"] || fieldMap["Email"] || "",
      phoneNumber: fieldMap["Phone Number"] || fieldMap["Phone"] || "N/A",
      companyName: fieldMap["Company Name"] || fieldMap["Company"] || integration.organizationName || "LinkedIn Org",
      source: "LinkedIn",
      status: "Cold",
      linkedinLeadId,
      linkedinCampaignId: leadData.campaign || "",
      linkedinCampaignName: campaignName,
      linkedinFormId: integration.leadFormUrn,
      linkedinFormName: integration.leadFormName,
      notes: `Auto-captured from LinkedIn Lead Gen Form: ${integration.leadFormName}`,
    });

    await LinkedInWebhookLog.create({
      payload,
      leadFormUrn,
      status: "success",
    });

    console.log(`✅ Webhook captured LinkedIn lead ${linkedinLeadId} successfully for tenant ${mapping.dbName}`);
  } catch (err) {
    console.error("LinkedIn Webhook error:", err.message);
    await LinkedInWebhookLog.create({
      payload,
      status: "failed",
      error: err.message,
    });
  }
};
