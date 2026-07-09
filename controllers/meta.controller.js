/**
 * meta.controller.js
 * Facebook / Instagram Lead Capture — Multi-tenant
 *
 * Flow:
 *  1. Tenant clicks "Connect Facebook" → GET /meta/auth-url  → returns OAuth URL
 *  2. User approves on Facebook → redirected to frontend callback with ?code=
 *  3. Frontend calls POST /meta/callback with { code }
 *     → backend exchanges code for long-lived page access token
 *     → fetches list of pages tenant manages
 *     → saves first/selected page to MetaIntegration collection
 *  4. Meta Webhook fires on new lead → POST /webhooks/meta (public route)
 *     → fetches lead details from Graph API
 *     → creates Lead in tenant's DB
 */

import axios  from "axios";
import crypto from "crypto";
import { getTenantModels } from "../models/tenant/index.js";
import { isFeatureEnabled } from "../utils/planFeatures.js";

const GRAPH_API  = "https://graph.facebook.com/v21.0";
const APP_ID     = process.env.META_APP_ID;
const APP_SECRET = process.env.META_APP_SECRET;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Exchange short-lived user token → long-lived user token (~60 days) */
const getLongLivedToken = async (shortToken) => {
  const { data } = await axios.get(`${GRAPH_API}/oauth/access_token`, {
    params: {
      grant_type:        "fb_exchange_token",
      client_id:         APP_ID,
      client_secret:     APP_SECRET,
      fb_exchange_token: shortToken,
    },
  });
  return data; // { access_token, token_type, expires_in }
};

/** Fetch all pages the user manages + their page access tokens */
const getUserPages = async (userToken) => {
  const { data } = await axios.get(`${GRAPH_API}/me/accounts`, {
    params: {
      access_token: userToken,
      fields:       "id,name,access_token,instagram_business_account{id,username}",
    },
  });
  return data.data || []; // array of page objects
};

/** Fetch a single lead's field values using the lead's page access token */
const fetchLeadDetails = async (leadgenId, pageAccessToken) => {
  const { data } = await axios.get(`${GRAPH_API}/${leadgenId}`, {
    params: {
      access_token: pageAccessToken,
      fields:       "field_data,created_time,ad_name,form_id",
    },
  });
  return data;
};

// ─── Controllers ─────────────────────────────────────────────────────────────

export default {

  /**
   * GET /:tenantSlug/api/meta/auth-url
   * Returns the Facebook OAuth URL for the tenant to click
   */
  getAuthUrl: (req, res) => {
    try {
      if (!APP_ID) return res.status(500).json({ success: false, message: "META_APP_ID not configured in .env" });

      const redirectUri = `${process.env.FRONTEND_URL}/integrations/facebook/callback`;
      const scopes      = [
        "pages_show_list",
        "leads_retrieval",
        "pages_read_engagement",
        "pages_manage_ads",
      ].join(",");

      // state carries tenantSlug so frontend can send it back in callback
      const state = req.tenant?.slug || "default";

      const url = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scopes}&state=${state}&response_type=code`;

      res.json({ success: true, authUrl: url });
    } catch (err) {
      console.error("Meta getAuthUrl error:", err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  },

  /**
   * POST /:tenantSlug/api/meta/callback
   * Body: { code, pageId? }  — code from Facebook OAuth redirect
   * Exchanges code → long-lived token → saves page integration
   */
  handleCallback: async (req, res) => {
    try {
      const { code, userToken: existingToken, pageId } = req.body;

      let userToken;

      if (existingToken) {
        // Step 2 of page picker flow — userToken already exchanged, just use it
        userToken = existingToken;
      } else {
        // Step 1 — exchange the one-time code for a long-lived token
        if (!code) return res.status(400).json({ success: false, message: "Authorization code is required" });

        const redirectUri = `${process.env.FRONTEND_URL}/integrations/facebook/callback`;

        const tokenRes = await axios.get(`${GRAPH_API}/oauth/access_token`, {
          params: { client_id: APP_ID, client_secret: APP_SECRET, redirect_uri: redirectUri, code },
        });
        const shortLivedToken = tokenRes.data.access_token;

        // Exchange short-lived → long-lived (~60 days)
        const longLived = await getLongLivedToken(shortLivedToken);
        userToken = longLived.access_token;
      }

      // Fetch pages this user manages
      const pages = await getUserPages(userToken);
      if (!pages.length) {
        return res.status(400).json({ success: false, message: "No Facebook Pages found. Please create a Page first." });
      }

      // If no pageId yet → return page list + userToken so frontend can pick without re-using the code
      if (!pageId) {
        return res.json({
          success:    true,
          selectPage: true,
          userToken,                          // frontend stores this, sends back on page selection
          pages: pages.map(p => ({
            pageId:       p.id,
            pageName:     p.name,
            hasInstagram: !!p.instagram_business_account,
          })),
        });
      }

      // Find the chosen page
      const selectedPage = pages.find(p => p.id === pageId);
      if (!selectedPage) return res.status(400).json({ success: false, message: "Selected page not found in your Facebook account" });

      // Subscribe the page to our app's webhook for leadgen events
      try {
        await axios.post(
          `${GRAPH_API}/${selectedPage.id}/subscribed_apps`,
          null,
          {
            params: {
              subscribed_fields: "leadgen",
              access_token:      selectedPage.access_token,
            },
          }
        );
        console.log(`✅ Page "${selectedPage.name}" subscribed to leadgen webhook`);
      } catch (subErr) {
        // Non-fatal — log but continue (manual subscription in Meta portal still works)
        console.warn(`⚠️  Page subscription warning:`, subErr.response?.data?.error?.message || subErr.message);
      }

      // Save to MetaIntegration
      const { MetaIntegration } = getTenantModels(req.tenantDB);
      const integration = await MetaIntegration.findOneAndUpdate(
        { facebookPageId: selectedPage.id },
        {
          facebookPageId:     selectedPage.id,
          pageName:           selectedPage.name,
          pageAccessToken:    selectedPage.access_token,
          instagramAccountId: selectedPage.instagram_business_account?.id || null,
          instagramUsername:  selectedPage.instagram_business_account?.username || "",
          status:             "active",
          webhookSubscribed:  true,
          connectedBy:        req.user._id,
        },
        { upsert: true, new: true }
      );

      res.json({ success: true, message: `Facebook Page "${selectedPage.name}" connected successfully!`, integration });
    } catch (err) {
      console.error("Meta callback error:", err.response?.data || err.message);
      const msg = err.response?.data?.error?.message || err.message;
      res.status(500).json({ success: false, message: msg });
    }
  },

  /**
   * GET /:tenantSlug/api/meta/integrations
   * List all connected Facebook pages for this tenant
   */
  getIntegrations: async (req, res) => {
    try {
      const { MetaIntegration } = getTenantModels(req.tenantDB);
      const integrations = await MetaIntegration.find({ status: "active" })
        .populate("connectedBy", "firstName lastName email")
        .sort({ createdAt: -1 });
      res.json({ success: true, data: integrations });
    } catch (err) {
      console.error("Meta getIntegrations error:", err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  },

  /**
   * DELETE /:tenantSlug/api/meta/integrations/:pageId
   * Disconnect a Facebook Page
   */
  disconnectPage: async (req, res) => {
    try {
      const { MetaIntegration } = getTenantModels(req.tenantDB);
      const integration = await MetaIntegration.findOneAndUpdate(
        { facebookPageId: req.params.pageId },
        { status: "disconnected" },
        { new: true }
      );
      if (!integration) return res.status(404).json({ success: false, message: "Integration not found" });
      res.json({ success: true, message: "Facebook Page disconnected" });
    } catch (err) {
      console.error("Meta disconnectPage error:", err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  },

  /**
   * POST /:tenantSlug/api/meta/sync
   * Manually pull all leads from connected Facebook Pages via Graph API.
   * Creates any new leads that aren't already in the CRM (deduped by meta.leadgenId).
   */
  syncLeads: async (req, res) => {
    try {
      const { MetaIntegration, Lead } = getTenantModels(req.tenantDB);

      const integrations = await MetaIntegration.find({ status: "active" });
      if (!integrations.length) {
        return res.status(400).json({ success: false, message: "No active Facebook Pages connected." });
      }

      let totalCreated = 0;
      let totalSkipped = 0;
      const errors     = [];

      for (const integration of integrations) {
        try {
          // 1. Fetch all lead forms for this page
          const formsRes = await axios.get(`${GRAPH_API}/${integration.facebookPageId}/leadgen_forms`, {
            params: { access_token: integration.pageAccessToken, fields: "id,name,status" },
          });
          const forms = formsRes.data?.data || [];
          console.log(`📋 Page "${integration.pageName}" has ${forms.length} lead form(s)`);

          for (const form of forms) {
            try {
              // 2. Fetch all leads for this form
              const leadsRes = await axios.get(`${GRAPH_API}/${form.id}/leads`, {
                params: {
                  access_token: integration.pageAccessToken,
                  fields: "id,created_time,field_data,ad_id,form_id",
                  limit: 100,
                },
              });
              const leads = leadsRes.data?.data || [];
              console.log(`  📝 Form "${form.name}" → ${leads.length} lead(s)`);

              for (const leadData of leads) {
                // 3. Skip if already in CRM (dedupe by leadgenId)
                const exists = await Lead.findOne({ "meta.leadgenId": leadData.id });
                if (exists) { totalSkipped++; continue; }

                // 4. Parse field_data array into a map
                const fields = {};
                (leadData.field_data || []).forEach(f => { fields[f.name] = f.values?.[0] || ""; });

                const name  = fields.full_name
                              || (`${fields.first_name || ""} ${fields.last_name || ""}`).trim()
                              || fields.name
                              || "Facebook Lead";
                const email   = fields.email        || `fb_${leadData.id}@noreply.com`;
                const phone   = fields.phone_number || fields.phone || fields.mobile_number || "N/A";
                const company = fields.company_name || fields.company || integration.pageName;

                await Lead.create({
                  leadName:    name,
                  email,
                  phoneNumber: phone,
                  companyName: company,
                  source:      integration.instagramAccountId ? "Instagram" : "Facebook",
                  status:      "Cold",
                  notes:       `Synced from Facebook Lead Form: ${form.name}`,
                  meta: {
                    leadgenId: leadData.id,
                    pageId:    integration.facebookPageId,
                    formId:    form.id,
                    rawFields: fields,
                  },
                });
                totalCreated++;
                console.log(`  ✅ Lead synced: ${name || leadData.id}`);
              }
            } catch (formErr) {
              const msg = formErr.response?.data?.error?.message || formErr.message;
              errors.push(`Form "${form.name}": ${msg}`);
              console.warn(`  ⚠️ Error fetching leads for form "${form.name}":`, msg);
            }
          }
        } catch (pageErr) {
          const msg = pageErr.response?.data?.error?.message || pageErr.message;
          errors.push(`Page "${integration.pageName}": ${msg}`);
          console.warn(`⚠️ Error fetching forms for page "${integration.pageName}":`, msg);
        }
      }

      res.json({
        success: true,
        message: `Sync complete: ${totalCreated} new lead(s) added, ${totalSkipped} already existed.`,
        totalCreated,
        totalSkipped,
        errors: errors.length ? errors : undefined,
      });
    } catch (err) {
      console.error("Meta syncLeads error:", err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  },

  /**
   * POST /:tenantSlug/api/meta/test-lead  (DEVELOPMENT ONLY)
   * Simulates a Facebook lead arriving — bypasses Meta webhooks entirely.
   * Body: { name?, email?, phone?, company? }
   */
  simulateTestLead: async (req, res) => {
    try {
      const { MetaIntegration, Lead } = getTenantModels(req.tenantDB);

      // Find connected page for this tenant
      const integration = await MetaIntegration.findOne({ status: "active" });
      if (!integration) {
        return res.status(400).json({ success: false, message: "No active Facebook Page connected. Go to Integrations and connect a page first." });
      }

      const name    = req.body.name    || "Test Facebook Lead";
      const email   = req.body.email   || "testlead@facebook.com";
      const phone   = req.body.phone   || "+1 555-123-4567";
      const company = req.body.company || integration.pageName || "Test Company";

      // Check for existing test lead with same email to avoid duplicates
      const existing = await Lead.findOne({ email, source: { $in: ["Facebook", "Instagram"] } });
      if (existing) {
        return res.status(400).json({ success: false, message: "A test lead with this email already exists. Delete it first or use a different email." });
      }

      const lead = await Lead.create({
        leadName:    name,
        email,
        phoneNumber: phone,
        companyName: company,
        source:      integration.instagramAccountId ? "Instagram" : "Facebook",
        status:      "Cold",
        notes:       `[TEST] Simulated Facebook lead from page: ${integration.pageName}`,
        meta: {
          leadgenId: `test_${Date.now()}`,
          pageId:    integration.facebookPageId,
          formId:    "test_form",
          rawFields: { full_name: name, email, phone_number: phone, company_name: company },
        },
      });

      console.log(`✅ [TEST] Simulated Facebook lead created: ${name} (${email})`);
      res.json({ success: true, message: "Test lead created successfully!", lead });
    } catch (err) {
      console.error("simulateTestLead error:", err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  },

  // ─── WEBHOOK HANDLERS (Public — called by Meta, no auth) ──────────────────

  /**
   * GET /webhooks/meta
   * Meta calls this to verify your webhook endpoint
   */
  verifyWebhook: (req, res) => {
    // Meta sends both hub.mode (dot) and hub_mode (underscore)
    // Express qs parser keeps only the underscore version
    const mode      = req.query.hub_mode;
    const token     = req.query.hub_verify_token;
    const challenge = req.query.hub_challenge;

    if (mode === "subscribe" && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
      console.log("✅ Meta webhook verified");
      return res.status(200).send(challenge);
    }
    console.warn("❌ Meta webhook verification failed", { mode, token });
    res.status(403).send("Forbidden");
  },

  /**
   * POST /webhooks/meta
   * Meta sends lead events here (real-time)
   * Payload contains: object="page", entry[].changes[].value = { leadgen_id, page_id, form_id, ... }
   */
  receiveWebhook: async (req, res) => {
    // ── Security: Verify Meta's HMAC-SHA256 signature ─────────────────────
    // Meta signs every POST body with your APP_SECRET.
    // If signature is missing or wrong → reject (could be a forged request).
    const signature = req.headers["x-hub-signature-256"];
    if (!signature) {
      console.warn("❌ Meta webhook: missing x-hub-signature-256 header");
      return res.status(403).send("Forbidden");
    }
    const rawBody  = req.rawBody || Buffer.from(JSON.stringify(req.body));
    const expected = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(rawBody).digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      console.warn("❌ Meta webhook: signature mismatch — possible forged request");
      return res.status(403).send("Forbidden");
    }
    // ── End security check ────────────────────────────────────────────────

    // Respond immediately to Meta (must respond within 5 seconds)
    res.status(200).send("EVENT_RECEIVED");

    try {
      const body = req.body;
      if (body.object !== "page") return;

      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          if (change.field !== "leadgen") continue;

          const { leadgen_id, page_id, form_id } = change.value;
          console.log(`📥 Meta lead received | page: ${page_id} | lead: ${leadgen_id}`);

          // Find which tenant owns this page_id
          // We need to search across all tenant DBs — handled by importing tenantDB config
          setImmediate(() => processMetaLead({ leadgen_id, page_id, form_id }));
        }
      }
    } catch (err) {
      console.error("Meta webhook processing error:", err.message);
    }
  },
};

// ─── Background Lead Processing ───────────────────────────────────────────────

/**
 * Find the tenant that has this page_id connected,
 * fetch lead details from Graph API,
 * create a Lead in their DB
 */
const processMetaLead = async ({ leadgen_id, page_id, form_id }) => {
  try {
    // Import here to avoid circular deps
    const { getTenantDB } = await import("../config/tenantDB.js");
    const { default: TenantMaster } = await import("../models/master/Tenant.js");
    const { registerTenantModels, getTenantModels } = await import("../models/tenant/index.js");

    // Find all active tenants
    const tenants = await TenantMaster.find({ status: "active" }).populate("plan_id");

    for (const tenant of tenants) {
      const conn = await getTenantDB(tenant.slug);
      registerTenantModels(conn);
      const { MetaIntegration, Lead } = getTenantModels(conn);

      // Check if this tenant has this page connected
      const integration = await MetaIntegration.findOne({
        facebookPageId: page_id,
        status: "active",
      });

      if (!integration) continue;

      // The tenant may have connected this page before their plan dropped
      // Facebook integration — stop ingesting leads for them going forward.
      if (!isFeatureEnabled(tenant.plan_id?.features, "integration_facebook")) {
        console.log(`⏭️  Skipping Meta lead for tenant ${tenant.slug} — integration_facebook disabled on plan`);
        break;
      }

      // Found the tenant — fetch lead details from Graph API
      let leadData;
      try {
        leadData = await fetchLeadDetails(leadgen_id, integration.pageAccessToken);
      } catch (apiErr) {
        console.error(`Meta Graph API error for lead ${leadgen_id}:`, apiErr.response?.data || apiErr.message);
        break;
      }

      // Parse field_data into a flat object
      const fields = {};
      for (const f of leadData.field_data || []) {
        fields[f.name] = f.values?.[0] || "";
      }

      // Map Facebook fields → CRM Lead fields
      const fullName   = fields["full_name"] || `${fields["first_name"] || ""} ${fields["last_name"] || ""}`.trim() || "Facebook Lead";
      const email      = fields["email"] || "";
      const phone      = fields["phone_number"] || fields["phone"] || "N/A";
      const company    = fields["company_name"] || fields["company"] || integration.pageName || "Unknown";

      // Avoid duplicates — check by leadgen_id stored in notes or by email+phone
      const existing = await Lead.findOne({ "meta.leadgenId": leadgen_id });
      if (existing) {
        console.log(`⚠️  Lead ${leadgen_id} already exists — skipping`);
        break;
      }

      // Create the lead
      await Lead.create({
        leadName:    fullName,
        email,
        phoneNumber: phone,
        companyName: company,
        source:      integration.instagramAccountId ? "Instagram" : "Facebook",
        status:      "Cold",
        notes:       `Auto-captured from ${integration.instagramAccountId ? "Instagram" : "Facebook"} Lead Form\nForm ID: ${form_id}\nPage: ${integration.pageName}`,
        meta: {
          leadgenId: leadgen_id,
          pageId:    page_id,
          formId:    form_id,
          rawFields: fields,
        },
      });

      console.log(`✅ Lead created for tenant "${tenant.slug}": ${fullName} (${email})`);
      break; // Found the tenant, stop searching
    }
  } catch (err) {
    console.error("processMetaLead error:", err.message);
  }
};

