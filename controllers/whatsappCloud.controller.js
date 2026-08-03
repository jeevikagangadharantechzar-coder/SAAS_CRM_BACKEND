import axios from "axios";
import { getTenantModels } from "../models/tenant/index.js";
import { getTenantDB } from "../config/tenantDB.js";
import Tenant from "../models/master/Tenant.js";
import { connectedUsers } from "../realtime/socket.js";

const GRAPH_API = "https://graph.facebook.com/v21.0";
const APP_ID     = process.env.META_APP_ID;
const APP_SECRET = process.env.META_APP_SECRET;
const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN;

// ─── helpers ──────────────────────────────────────────────────────────────────

async function exchangeCodeForToken(code, redirectUri) {
  const { data } = await axios.get(`${GRAPH_API}/oauth/access_token`, {
    params: {
      client_id:     APP_ID,
      client_secret: APP_SECRET,
      redirect_uri:  redirectUri,
      code,
    },
  });
  return data.access_token; // short-lived token
}

async function getLongLivedToken(shortToken) {
  const { data } = await axios.get(`${GRAPH_API}/oauth/access_token`, {
    params: {
      grant_type:        "fb_exchange_token",
      client_id:         APP_ID,
      client_secret:     APP_SECRET,
      fb_exchange_token: shortToken,
    },
  });
  // expires_in is in seconds (~5184000 = 60 days)
  const expiresAt = data.expires_in
    ? new Date(Date.now() + data.expires_in * 1000)
    : null;
  return { token: data.access_token, expiresAt };
}

async function getWABAs(userToken) {
  const { data } = await axios.get(`${GRAPH_API}/me/whatsapp_business_accounts`, {
    params: {
      access_token: userToken,
      fields: "id,name,currency,account_review_status,message_template_namespace",
    },
  });
  return data.data || [];
}

async function getPhoneNumbers(wabaId, userToken) {
  const { data } = await axios.get(`${GRAPH_API}/${wabaId}/phone_numbers`, {
    params: {
      access_token: userToken,
      fields: "id,display_phone_number,verified_name,status,quality_rating,code_verification_status",
    },
  });
  return data.data || [];
}

async function subscribeWABAToWebhook(wabaId, userToken) {
  await axios.post(
    `${GRAPH_API}/${wabaId}/subscribed_apps`,
    {},
    { params: { access_token: userToken } }
  );
}

async function downloadMetaMedia(mediaId, accessToken) {
  // Step 1: get download URL
  const { data: meta } = await axios.get(`${GRAPH_API}/${mediaId}`, {
    params: { access_token: accessToken },
  });
  // meta.url is a short-lived download URL
  return { url: meta.url, mimeType: meta.mime_type };
}

// Find which tenant owns a given phone_number_id (for webhook routing)
async function findTenantByPhoneNumberId(phoneNumberId) {
  const tenants = await Tenant.find().lean();
  for (const tenant of tenants) {
    try {
      const conn = await getTenantDB(tenant.dbName);
      const { WhatsAppIntegration } = getTenantModels(conn);
      const integration = await WhatsAppIntegration.findOne({
        phoneNumberId,
        status: "active",
      }).lean();
      if (integration) {
        return { tenant, conn, integration };
      }
    } catch (_) {
      // skip tenant if its DB is unreachable
    }
  }
  return null;
}

// ─── Auth & Connect ───────────────────────────────────────────────────────────

// Embedded Signup / popup OAuth connect — frontend sends code from FB.login()
// If phoneNumberId + wabaId are provided (from Embedded Signup session data) → save directly
// Otherwise → return phone list for user to pick (then use confirmPhoneNumber to save)
export async function connectEmbeddedSignup(req, res) {
  try {
    const { code, userToken, phoneNumberId, wabaId } = req.body;

    if (!code && !userToken) {
      return res.status(400).json({ success: false, message: "Authorization code or access token is required." });
    }

    // Exchange code → short-lived token (no redirect_uri — popup flow)
    // OR use userToken directly (token flow fallback when no config_id)
    let shortToken;
    if (code) {
      try {
        const { data } = await axios.get(`${GRAPH_API}/oauth/access_token`, {
          params: { client_id: APP_ID, client_secret: APP_SECRET, code },
        });
        shortToken = data.access_token;
      } catch (err) {
        const msg = err.response?.data?.error?.message || "Failed to exchange authorization code";
        return res.status(400).json({ success: false, message: msg });
      }
    } else {
      shortToken = userToken;
    }

    let longToken = shortToken;
    let expiresAt = null;
    try {
      const result = await getLongLivedToken(shortToken);
      longToken = result.token;
      expiresAt = result.expiresAt;
    } catch (err) {
      console.warn("getLongLivedToken failed, using short-lived token:", err.response?.data?.error?.message || err.message);
    }

    // ── Case 1: Embedded Signup gave us phoneNumberId + wabaId directly ──
    if (phoneNumberId && wabaId) {
      let phoneNumber, verifiedName;
      try {
        const { data: phoneInfo } = await axios.get(`${GRAPH_API}/${phoneNumberId}`, {
          params: { fields: "display_phone_number,verified_name,status,quality_rating", access_token: longToken },
        });
        phoneNumber  = phoneInfo.display_phone_number;
        verifiedName = phoneInfo.verified_name;
      } catch (verifyErr) {
        const errMsg = verifyErr.response?.data?.error?.message || "Could not verify phone number";
        return res.status(400).json({ success: false, message: `Verification failed: ${errMsg}` });
      }

      const { WhatsAppIntegration } = getTenantModels(req.tenantDB);
      const existing = await WhatsAppIntegration.findOne({ phoneNumberId, status: "active" });
      if (existing) {
        return res.status(409).json({ success: false, message: "This WhatsApp number is already connected." });
      }

      try { await subscribeWABAToWebhook(wabaId, longToken); } catch (e) {
        console.warn("Webhook subscription warning:", e.response?.data || e.message);
      }

      const integration = await WhatsAppIntegration.create({
        wabaId, phoneNumberId, phoneNumber,
        displayName: verifiedName || phoneNumber,
        accessToken: longToken, tokenExpiresAt: expiresAt,
        status: "active", webhookSubscribed: true, connectedBy: req.user._id,
      });

      return res.json({
        success: true, integration,
        webhookUrl:  `${process.env.BACKEND_URL || "https://crm-backend-api.techzarinfo.cloud"}/webhooks/whatsapp`,
        verifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || "",
      });
    }

    // ── Case 2: Regular OAuth — return phone list for selection ──
    const wabas = await getWABAs(longToken);
    if (!wabas.length) {
      return res.status(400).json({
        success: false,
        message: "No WhatsApp Business Account found. Make sure you are an admin of a WABA in Meta Business Manager.",
      });
    }

    const phones = [];
    for (const waba of wabas) {
      const numbers = await getPhoneNumbers(waba.id, longToken);
      for (const num of numbers) {
        phones.push({
          wabaId: waba.id, wabaName: waba.name,
          phoneNumberId: num.id, phoneNumber: num.display_phone_number,
          displayName: num.verified_name || waba.name,
          status: num.status, qualityRating: num.quality_rating,
          verified: num.code_verification_status === "VERIFIED",
        });
      }
    }

    if (!phones.length) {
      return res.status(400).json({
        success: false,
        message: "No WhatsApp phone numbers found. Please add a verified phone number in Meta Business Manager first.",
      });
    }

    res.json({ success: true, selectPhone: true, phones, userToken: longToken, tokenExpiresAt: expiresAt });
  } catch (err) {
    console.error("WhatsApp connectEmbeddedSignup error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

// Direct credential connect — tenant pastes Phone Number ID, WABA ID, Access Token
export async function connectManual(req, res) {
  try {
    const { phoneNumberId, wabaId, accessToken, displayName } = req.body;

    if (!phoneNumberId || !wabaId || !accessToken) {
      return res.status(400).json({
        success: false,
        message: "Phone Number ID, WABA ID, and Access Token are all required.",
      });
    }

    // Verify credentials by fetching phone info from Meta
    let phoneNumber, verifiedName;
    try {
      const { data: phoneInfo } = await axios.get(`${GRAPH_API}/${phoneNumberId}`, {
        params: {
          fields: "display_phone_number,verified_name,status,quality_rating",
          access_token: accessToken,
        },
      });
      phoneNumber  = phoneInfo.display_phone_number;
      verifiedName = phoneInfo.verified_name;
    } catch (verifyErr) {
      const errMsg = verifyErr.response?.data?.error?.message || "Could not verify credentials";
      return res.status(400).json({ success: false, message: `Verification failed: ${errMsg}` });
    }

    const { WhatsAppIntegration } = getTenantModels(req.tenantDB);

    const existing = await WhatsAppIntegration.findOne({ phoneNumberId, status: "active" });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "This WhatsApp number is already connected to this account.",
      });
    }

    // Subscribe WABA to webhook (non-fatal if it fails)
    try {
      await subscribeWABAToWebhook(wabaId, accessToken);
    } catch (subErr) {
      console.warn("WhatsApp webhook subscription warning:", subErr.response?.data || subErr.message);
    }

    const integration = await WhatsAppIntegration.create({
      wabaId,
      phoneNumberId,
      phoneNumber,
      displayName:       displayName || verifiedName || phoneNumber,
      accessToken,
      tokenExpiresAt:    null, // system user tokens don't expire
      status:            "active",
      webhookSubscribed: true,
      connectedBy:       req.user._id,
    });

    res.json({
      success:     true,
      integration,
      webhookUrl:   `${process.env.BACKEND_URL || "https://crm-backend-api.techzarinfo.cloud"}/webhooks/whatsapp`,
      verifyToken:  process.env.META_WEBHOOK_VERIFY_TOKEN || "",
    });
  } catch (err) {
    console.error("WhatsApp connectManual error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function getAuthUrl(req, res) {
  try {
    const { tenantSlug } = req.params;
    const redirectUri = `${process.env.FRONTEND_URL}/integrations/whatsapp/callback`;

    const url =
      `https://www.facebook.com/v21.0/dialog/oauth` +
      `?client_id=${APP_ID}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=whatsapp_business_messaging,whatsapp_business_management` +
      `&response_type=code` +
      `&state=${tenantSlug}`;

    res.json({ success: true, url });
  } catch (err) {
    console.error("WhatsApp getAuthUrl error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

// Step 1 of connect: exchange code → return list of phone numbers to pick from
export async function handleCallback(req, res) {
  try {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ success: false, message: "Authorization code is required." });
    }

    const redirectUri = `${process.env.FRONTEND_URL}/integrations/whatsapp/callback`;

    // Exchange one-time code for short-lived token
    const shortToken = await exchangeCodeForToken(code, redirectUri);

    // Upgrade to long-lived token (~60 days)
    const { token: longToken, expiresAt } = await getLongLivedToken(shortToken);

    // Fetch all WABAs the user manages
    const wabas = await getWABAs(longToken);
    if (!wabas.length) {
      return res.status(400).json({
        success: false,
        message:
          "No WhatsApp Business Account found on your Meta account. " +
          "Please make sure you are an admin of a WhatsApp Business Account (WABA) in Meta Business Manager.",
      });
    }

    // Collect phone numbers from all WABAs
    const phones = [];
    for (const waba of wabas) {
      const numbers = await getPhoneNumbers(waba.id, longToken);
      for (const num of numbers) {
        phones.push({
          wabaId:        waba.id,
          wabaName:      waba.name,
          phoneNumberId: num.id,
          phoneNumber:   num.display_phone_number,
          displayName:   num.verified_name || waba.name,
          status:        num.status,
          qualityRating: num.quality_rating,
          verified:      num.code_verification_status === "VERIFIED",
        });
      }
    }

    if (!phones.length) {
      return res.status(400).json({
        success: false,
        message:
          "No WhatsApp phone numbers found in your Business Account. " +
          "Please add and verify a phone number in Meta Business Manager before connecting.",
      });
    }

    // Return phone list + token for next step (frontend stores token in state, not code)
    res.json({
      success: true,
      selectPhone: true,
      phones,
      userToken:  longToken,
      tokenExpiresAt: expiresAt,
    });
  } catch (err) {
    console.error("WhatsApp callback error:", err.response?.data || err.message);
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ success: false, message: msg });
  }
}

// Step 2 of connect: save the chosen phone number + subscribe webhook
export async function confirmPhoneNumber(req, res) {
  try {
    const { userToken, tokenExpiresAt, wabaId, phoneNumberId, phoneNumber, displayName } = req.body;

    if (!userToken || !wabaId || !phoneNumberId || !phoneNumber) {
      return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    const { WhatsAppIntegration } = getTenantModels(req.tenantDB);

    // Check if this phone number is already connected for this tenant
    const existing = await WhatsAppIntegration.findOne({ phoneNumberId, status: "active" });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "This WhatsApp number is already connected to this account.",
      });
    }

    // Subscribe this WABA to our webhook so we receive inbound messages
    try {
      await subscribeWABAToWebhook(wabaId, userToken);
    } catch (subErr) {
      console.warn("WhatsApp webhook subscription warning:", subErr.response?.data || subErr.message);
      // Non-fatal — integration can still work; user can retry later
    }

    const integration = await WhatsAppIntegration.create({
      wabaId,
      phoneNumberId,
      phoneNumber,
      displayName:       displayName || "",
      accessToken:       userToken,
      tokenExpiresAt:    tokenExpiresAt ? new Date(tokenExpiresAt) : null,
      status:            "active",
      webhookSubscribed: true,
      connectedBy:       req.user._id,
    });

    res.json({ success: true, integration });
  } catch (err) {
    console.error("WhatsApp confirmPhoneNumber error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

// ─── Integration management ───────────────────────────────────────────────────

export async function getIntegrations(req, res) {
  try {
    const { WhatsAppIntegration } = getTenantModels(req.tenantDB);
    const integrations = await WhatsAppIntegration.find({ status: "active" })
      .populate("connectedBy", "name email")
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, integrations });
  } catch (err) {
    console.error("WhatsApp getIntegrations error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function disconnect(req, res) {
  try {
    const { id } = req.params;
    const { WhatsAppIntegration } = getTenantModels(req.tenantDB);

    const integration = await WhatsAppIntegration.findById(id);
    if (!integration) {
      return res.status(404).json({ success: false, message: "Integration not found." });
    }

    // Best-effort unsubscribe from webhook
    try {
      await axios.delete(`${GRAPH_API}/${integration.wabaId}/subscribed_apps`, {
        params: { access_token: integration.accessToken },
      });
    } catch (_) {
      // ignore — token may be expired, integration is still disconnected below
    }

    integration.status = "disconnected";
    await integration.save();

    res.json({ success: true, message: "WhatsApp integration disconnected." });
  } catch (err) {
    console.error("WhatsApp disconnect error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function refreshToken(req, res) {
  try {
    const { id } = req.params;
    const { WhatsAppIntegration } = getTenantModels(req.tenantDB);

    const integration = await WhatsAppIntegration.findById(id);
    if (!integration) {
      return res.status(404).json({ success: false, message: "Integration not found." });
    }

    const { token, expiresAt } = await getLongLivedToken(integration.accessToken);
    integration.accessToken   = token;
    integration.tokenExpiresAt = expiresAt;
    await integration.save();

    res.json({ success: true, message: "Token refreshed.", tokenExpiresAt: expiresAt });
  } catch (err) {
    console.error("WhatsApp refreshToken error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

// ─── Messaging ────────────────────────────────────────────────────────────────

export async function sendMessage(req, res) {
  try {
    const { integrationId, to, message } = req.body;

    if (!to || !message) {
      return res.status(400).json({ success: false, message: "Recipient 'to' and 'message' are required." });
    }

    const { WhatsAppIntegration, WhatsAppCloudMessage } = getTenantModels(req.tenantDB);

    // Get integration — use specified or fall back to first active
    let integration;
    if (integrationId) {
      integration = await WhatsAppIntegration.findById(integrationId);
    } else {
      integration = await WhatsAppIntegration.findOne({ status: "active" });
    }
    if (!integration) {
      return res.status(400).json({ success: false, message: "No active WhatsApp integration found. Please connect a number first." });
    }

    // Normalise recipient number: strip all non-digit chars
    const toClean = to.replace(/\D/g, "");
    if (toClean.length < 7 || toClean.length > 15) {
      return res.status(400).json({ success: false, message: "Invalid phone number format." });
    }

    // Send via Meta Cloud API
    const { data } = await axios.post(
      `${GRAPH_API}/${integration.phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type:    "individual",
        to:                toClean,
        type:              "text",
        text:              { preview_url: false, body: message },
      },
      {
        headers: {
          Authorization:  `Bearer ${integration.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    const waMessageId = data.messages?.[0]?.id || null;

    // Save outbound message
    const saved = await WhatsAppCloudMessage.create({
      phoneNumberId:     integration.phoneNumberId,
      waMessageId,
      contactWaId:       toClean,
      direction:         "outbound",
      type:              "text",
      body:              message,
      status:            "sent",
      sentBy:            req.user._id,
      whatsappTimestamp: new Date(),
    });

    res.json({ success: true, message: saved, waMessageId });
  } catch (err) {
    console.error("WhatsApp sendMessage error:", err.response?.data || err.message);
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ success: false, message: msg });
  }
}

export async function sendTemplateMessage(req, res) {
  try {
    const { integrationId, to, templateName, languageCode = "en_US", components = [] } = req.body;

    if (!to || !templateName) {
      return res.status(400).json({ success: false, message: "'to' and 'templateName' are required." });
    }

    const { WhatsAppIntegration, WhatsAppCloudMessage } = getTenantModels(req.tenantDB);

    let integration;
    if (integrationId) {
      integration = await WhatsAppIntegration.findById(integrationId);
    } else {
      integration = await WhatsAppIntegration.findOne({ status: "active" });
    }
    if (!integration) {
      return res.status(400).json({ success: false, message: "No active WhatsApp integration found." });
    }

    const toClean = to.replace(/\D/g, "");

    const { data } = await axios.post(
      `${GRAPH_API}/${integration.phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        to:               toClean,
        type:             "template",
        template: {
          name:     templateName,
          language: { code: languageCode },
          components,
        },
      },
      {
        headers: {
          Authorization:  `Bearer ${integration.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    const waMessageId = data.messages?.[0]?.id || null;

    const saved = await WhatsAppCloudMessage.create({
      phoneNumberId:     integration.phoneNumberId,
      waMessageId,
      contactWaId:       toClean,
      direction:         "outbound",
      type:              "text",
      body:              `[Template: ${templateName}]`,
      status:            "sent",
      sentBy:            req.user._id,
      whatsappTimestamp: new Date(),
    });

    res.json({ success: true, message: saved, waMessageId });
  } catch (err) {
    console.error("WhatsApp sendTemplateMessage error:", err.response?.data || err.message);
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ success: false, message: msg });
  }
}

// ─── Conversations & Messages ─────────────────────────────────────────────────

export async function getConversations(req, res) {
  try {
    const { integrationId } = req.query;
    const { WhatsAppIntegration, WhatsAppCloudMessage } = getTenantModels(req.tenantDB);

    let integration;
    if (integrationId) {
      integration = await WhatsAppIntegration.findById(integrationId);
    } else {
      integration = await WhatsAppIntegration.findOne({ status: "active" });
    }
    if (!integration) {
      return res.json({ success: true, conversations: [] });
    }

    // Latest message per contact (pipeline: sort desc → group → sort desc again)
    const conversations = await WhatsAppCloudMessage.aggregate([
      { $match: { phoneNumberId: integration.phoneNumberId } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id:             "$contactWaId",
          contactName:     { $first: "$contactName" },
          lastMessage:     { $first: "$body" },
          lastMessageType: { $first: "$type" },
          lastMessageTime: { $first: "$createdAt" },
          lastDirection:   { $first: "$direction" },
          lastStatus:      { $first: "$status" },
        },
      },
      { $sort: { lastMessageTime: -1 } },
      { $limit: 100 },
    ]);

    // Unread counts (separate query for accuracy)
    const unreadCounts = await WhatsAppCloudMessage.aggregate([
      {
        $match: {
          phoneNumberId: integration.phoneNumberId,
          direction:     "inbound",
          read:          false,
        },
      },
      { $group: { _id: "$contactWaId", count: { $sum: 1 } } },
    ]);
    const unreadMap = {};
    unreadCounts.forEach((u) => { unreadMap[u._id] = u.count; });

    let result = conversations.map((c) => ({
      contactWaId:     c._id,
      contactName:     c.contactName || c._id,
      lastMessage:     c.lastMessage,
      lastMessageType: c.lastMessageType,
      lastMessageTime: c.lastMessageTime,
      lastDirection:   c.lastDirection,
      lastStatus:      c.lastStatus,
      unreadCount:     unreadMap[c._id] || 0,
    }));

    // Enrich conversations: check if each contact already has a CRM lead
    try {
      const { Lead } = getTenantModels(req.tenantDB);
      const allLeads = await Lead.find({ phoneNumber: { $exists: true, $ne: "" } }, "_id leadName phoneNumber").lean();
      const phoneToLead = {};
      for (const lead of allLeads) {
        const stripped = lead.phoneNumber.replace(/\D/g, "");
        if (stripped) phoneToLead[stripped] = { leadId: lead._id, leadName: lead.leadName };
      }
      result = result.map((c) => ({ ...c, ...(phoneToLead[c.contactWaId] || {}) }));
    } catch (_) {}

    res.json({ success: true, conversations: result, integration });
  } catch (err) {
    console.error("WhatsApp getConversations error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function getMessages(req, res) {
  try {
    const { contactWaId } = req.params;
    const { integrationId, page = 1, limit = 50 } = req.query;

    if (!contactWaId) {
      return res.status(400).json({ success: false, message: "contactWaId is required." });
    }

    const { WhatsAppIntegration, WhatsAppCloudMessage } = getTenantModels(req.tenantDB);

    let integration;
    if (integrationId) {
      integration = await WhatsAppIntegration.findById(integrationId);
    } else {
      integration = await WhatsAppIntegration.findOne({ status: "active" });
    }
    if (!integration) {
      return res.status(400).json({ success: false, message: "No active WhatsApp integration found." });
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const messages = await WhatsAppCloudMessage.find({
      phoneNumberId: integration.phoneNumberId,
      contactWaId,
    })
      .populate("sentBy", "name email")
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    const total = await WhatsAppCloudMessage.countDocuments({
      phoneNumberId: integration.phoneNumberId,
      contactWaId,
    });

    res.json({ success: true, messages, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error("WhatsApp getMessages error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function markAsRead(req, res) {
  try {
    const { contactWaId } = req.params;
    const { integrationId } = req.body;

    const { WhatsAppIntegration, WhatsAppCloudMessage } = getTenantModels(req.tenantDB);

    let integration;
    if (integrationId) {
      integration = await WhatsAppIntegration.findById(integrationId);
    } else {
      integration = await WhatsAppIntegration.findOne({ status: "active" });
    }
    if (!integration) {
      return res.status(400).json({ success: false, message: "No active WhatsApp integration found." });
    }

    const result = await WhatsAppCloudMessage.updateMany(
      { phoneNumberId: integration.phoneNumberId, contactWaId, direction: "inbound", read: false },
      { $set: { read: true } }
    );

    // Also send "read" receipt to WhatsApp for the most recent inbound message
    try {
      const lastMsg = await WhatsAppCloudMessage.findOne({
        phoneNumberId: integration.phoneNumberId,
        contactWaId,
        direction:     "inbound",
        waMessageId:   { $ne: null },
      }).sort({ createdAt: -1 });

      if (lastMsg?.waMessageId) {
        await axios.post(
          `${GRAPH_API}/${integration.phoneNumberId}/messages`,
          {
            messaging_product: "whatsapp",
            status:            "read",
            message_id:        lastMsg.waMessageId,
          },
          { headers: { Authorization: `Bearer ${integration.accessToken}` } }
        );
      }
    } catch (_) {
      // Non-fatal — the read receipt is best-effort
    }

    res.json({ success: true, updated: result.modifiedCount });
  } catch (err) {
    console.error("WhatsApp markAsRead error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

// Proxy media download so frontend doesn't need the raw Meta token
export async function downloadMedia(req, res) {
  try {
    const { mediaId } = req.params;
    const { integrationId } = req.query;

    const { WhatsAppIntegration } = getTenantModels(req.tenantDB);

    let integration;
    if (integrationId) {
      integration = await WhatsAppIntegration.findById(integrationId);
    } else {
      integration = await WhatsAppIntegration.findOne({ status: "active" });
    }
    if (!integration) {
      return res.status(400).json({ success: false, message: "No active WhatsApp integration found." });
    }

    // Get the download URL from Meta
    const { data: meta } = await axios.get(`${GRAPH_API}/${mediaId}`, {
      params: { access_token: integration.accessToken },
    });

    // Stream the media to the client
    const response = await axios.get(meta.url, {
      responseType: "stream",
      headers: { Authorization: `Bearer ${integration.accessToken}` },
    });

    res.setHeader("Content-Type", meta.mime_type || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=3600");
    response.data.pipe(res);
  } catch (err) {
    console.error("WhatsApp downloadMedia error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

// ─── Media messages ───────────────────────────────────────────────────────────

export async function sendMedia(req, res) {
  try {
    const { integrationId, to, caption = "" } = req.body;
    const file = req.file;

    if (!file) return res.status(400).json({ success: false, message: "No file uploaded." });
    if (!to)   return res.status(400).json({ success: false, message: "Recipient 'to' is required." });

    const { WhatsAppIntegration, WhatsAppCloudMessage } = getTenantModels(req.tenantDB);

    let integration;
    if (integrationId) {
      integration = await WhatsAppIntegration.findById(integrationId);
    } else {
      integration = await WhatsAppIntegration.findOne({ status: "active" });
    }
    if (!integration) {
      return res.status(400).json({ success: false, message: "No active WhatsApp integration found." });
    }

    const toClean = to.replace(/\D/g, "");
    if (toClean.length < 7 || toClean.length > 15) {
      return res.status(400).json({ success: false, message: "Invalid phone number format." });
    }

    // Determine WhatsApp media type from MIME
    let waType = "document";
    if (file.mimetype.startsWith("image/")) waType = "image";
    else if (file.mimetype.startsWith("video/")) waType = "video";
    else if (file.mimetype.startsWith("audio/")) waType = "audio";

    // Build public URL for the uploaded file (must be reachable by Meta's servers)
    const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`;
    const fileUrl = `${BACKEND_URL}/uploads/whatsapp/${file.filename}`;

    // Build Meta API payload
    const msgPayload = {
      messaging_product: "whatsapp",
      recipient_type:    "individual",
      to:                toClean,
      type:              waType,
    };

    if (waType === "image")    msgPayload.image    = { link: fileUrl, caption };
    else if (waType === "video")   msgPayload.video    = { link: fileUrl, caption };
    else if (waType === "audio")   msgPayload.audio    = { link: fileUrl };
    else                           msgPayload.document = { link: fileUrl, filename: file.originalname, caption };

    const { data } = await axios.post(
      `${GRAPH_API}/${integration.phoneNumberId}/messages`,
      msgPayload,
      {
        headers: {
          Authorization:  `Bearer ${integration.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    const waMessageId = data.messages?.[0]?.id || null;

    const saved = await WhatsAppCloudMessage.create({
      phoneNumberId:     integration.phoneNumberId,
      waMessageId,
      contactWaId:       toClean,
      direction:         "outbound",
      type:              waType,
      body:              caption,
      mediaUrl:          fileUrl,
      mediaMimeType:     file.mimetype,
      mediaFilename:     file.originalname,
      status:            "sent",
      sentBy:            req.user._id,
      whatsappTimestamp: new Date(),
    });

    res.json({ success: true, message: saved, waMessageId });
  } catch (err) {
    console.error("WhatsApp sendMedia error:", err.response?.data || err.message);
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ success: false, message: msg });
  }
}

// ─── Message Templates ────────────────────────────────────────────────────────

export async function getTemplates(req, res) {
  try {
    const { integrationId } = req.query;
    const { WhatsAppIntegration } = getTenantModels(req.tenantDB);

    let integration;
    if (integrationId) {
      integration = await WhatsAppIntegration.findById(integrationId);
    } else {
      integration = await WhatsAppIntegration.findOne({ status: "active" });
    }
    if (!integration) {
      return res.status(400).json({ success: false, message: "No active WhatsApp integration found." });
    }

    const { data } = await axios.get(`${GRAPH_API}/${integration.wabaId}/message_templates`, {
      params: {
        access_token: integration.accessToken,
        fields:       "name,status,category,language,components",
        limit:        100,
      },
    });

    res.json({ success: true, templates: data.data || [] });
  } catch (err) {
    console.error("WhatsApp getTemplates error:", err.response?.data || err.message);
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ success: false, message: msg });
  }
}

// ─── Webhook (public — no auth) ───────────────────────────────────────────────

export function verifyWebhook(req, res) {
  const mode      = req.query["hub.mode"]         || req.query.hub_mode;
  const token     = req.query["hub.verify_token"] || req.query.hub_verify_token;
  const challenge = req.query["hub.challenge"]    || req.query.hub_challenge;

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("WhatsApp webhook verified");
    return res.status(200).send(challenge);
  }
  res.status(403).json({ message: "Webhook verification failed." });
}

export async function receiveWebhook(req, res) {
  // Always acknowledge immediately — Meta expects 200 within 5 seconds
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== "whatsapp_business_account") return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;
        const value = change.value;

        // ── Incoming messages ──────────────────────────────────
        if (value.messages?.length) {
          for (const msg of value.messages) {
            await processIncomingMessage(value.metadata, value.contacts, msg).catch((e) =>
              console.error("WhatsApp processIncomingMessage error:", e.message)
            );
          }
        }

        // ── Status updates (sent / delivered / read / failed) ──
        if (value.statuses?.length) {
          for (const status of value.statuses) {
            await processStatusUpdate(value.metadata, status).catch((e) =>
              console.error("WhatsApp processStatusUpdate error:", e.message)
            );
          }
        }
      }
    }
  } catch (err) {
    console.error("WhatsApp receiveWebhook processing error:", err.message);
  }
}

// ─── Internal webhook processors ─────────────────────────────────────────────

async function processIncomingMessage(metadata, contacts, msg) {
  const phoneNumberId = metadata?.phone_number_id;
  if (!phoneNumberId) return;

  const result = await findTenantByPhoneNumberId(phoneNumberId);
  if (!result) {
    console.warn(`WhatsApp: no tenant found for phone_number_id=${phoneNumberId}`);
    return;
  }

  const { conn, integration } = result;
  const { WhatsAppCloudMessage } = getTenantModels(conn);

  // Extract contact info
  const contactWaId = msg.from; // sender's WhatsApp number (no +)
  const contactInfo = contacts?.find((c) => c.wa_id === contactWaId);
  const contactName = contactInfo?.profile?.name || contactWaId;

  // Prevent duplicate processing (webhook can deliver same message more than once)
  const exists = await WhatsAppCloudMessage.findOne({ waMessageId: msg.id });
  if (exists) return;

  // Parse message content by type
  let type     = msg.type || "unknown";
  let body     = "";
  let mediaId  = null;
  let mediaMimeType = null;
  let mediaFilename = null;
  let location = null;
  let reaction = null;

  switch (type) {
    case "text":
      body = msg.text?.body || "";
      break;
    case "image":
      mediaId       = msg.image?.id;
      mediaMimeType = msg.image?.mime_type;
      body          = msg.image?.caption || "";
      break;
    case "audio":
      mediaId       = msg.audio?.id;
      mediaMimeType = msg.audio?.mime_type;
      break;
    case "video":
      mediaId       = msg.video?.id;
      mediaMimeType = msg.video?.mime_type;
      body          = msg.video?.caption || "";
      break;
    case "document":
      mediaId         = msg.document?.id;
      mediaMimeType   = msg.document?.mime_type;
      mediaFilename   = msg.document?.filename;
      body            = msg.document?.caption || "";
      break;
    case "sticker":
      mediaId       = msg.sticker?.id;
      mediaMimeType = msg.sticker?.mime_type;
      break;
    case "location":
      location = {
        latitude:  msg.location?.latitude,
        longitude: msg.location?.longitude,
        name:      msg.location?.name,
        address:   msg.location?.address,
      };
      body = msg.location?.name || "Location";
      break;
    case "reaction":
      reaction = {
        messageId: msg.reaction?.message_id,
        emoji:     msg.reaction?.emoji,
      };
      body = msg.reaction?.emoji || "";
      break;
    case "button":
      body = msg.button?.text || "";
      break;
    default:
      body = `[${type} message]`;
  }

  const whatsappTimestamp = msg.timestamp
    ? new Date(parseInt(msg.timestamp) * 1000)
    : new Date();

  const saved = await WhatsAppCloudMessage.create({
    phoneNumberId,
    waMessageId:       msg.id,
    contactWaId,
    contactName,
    direction:         "inbound",
    type,
    body,
    mediaId,
    mediaMimeType,
    mediaFilename,
    location,
    reaction,
    status:            "delivered",
    read:              false,
    whatsappTimestamp,
  });

  // Emit real-time socket event to all connected users of this tenant
  try {
    const { User } = getTenantModels(conn);
    const tenantUsers = await User.find({}, "_id").lean();
    const payload = {
      message:       saved,
      contactWaId,
      contactName,
      phoneNumberId,
      integrationId: integration._id,
    };
    for (const u of tenantUsers) {
      const sockets = connectedUsers[String(u._id)];
      if (sockets?.length) sockets.forEach((s) => s.emit("whatsapp:message", payload));
    }
  } catch (_) {
    // socket not critical — message is already saved to DB
  }
}

async function processStatusUpdate(metadata, statusUpdate) {
  const phoneNumberId = metadata?.phone_number_id;
  if (!phoneNumberId) return;

  const result = await findTenantByPhoneNumberId(phoneNumberId);
  if (!result) return;

  const { conn } = result;
  const { WhatsAppCloudMessage } = getTenantModels(conn);

  const statusMap = {
    sent:      "sent",
    delivered: "delivered",
    read:      "read",
    failed:    "failed",
  };
  const newStatus = statusMap[statusUpdate.status] || statusUpdate.status;

  await WhatsAppCloudMessage.findOneAndUpdate(
    { waMessageId: statusUpdate.id },
    { $set: { status: newStatus, statusUpdatedAt: new Date() } }
  );

  // Push status change to all connected CRM users of this tenant in real time
  try {
    const { User } = getTenantModels(conn);
    const tenantUsers = await User.find({}, "_id").lean();
    const payload = { waMessageId: statusUpdate.id, status: newStatus, phoneNumberId };
    for (const u of tenantUsers) {
      const sockets = connectedUsers[String(u._id)];
      if (sockets?.length) sockets.forEach((s) => s.emit("whatsapp:status", payload));
    }
  } catch (_) {}
}
