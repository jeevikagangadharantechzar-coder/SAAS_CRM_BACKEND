import axios from "axios";
import { getTenantModels } from "../models/tenant/index.js";
import { getTenantDB } from "../config/tenantDB.js";
import Tenant from "../models/master/Tenant.js";
import { connectedUsers } from "../realtime/socket.js";

const GRAPH = "https://graph.facebook.com/v21.0";
const APP_ID      = process.env.META_APP_ID;
const APP_SECRET  = process.env.META_APP_SECRET;
const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN;

// ── helpers ────────────────────────────────────────────────────────────────────

async function exchangeCodeForToken(code, redirectUri) {
  const { data } = await axios.get(`${GRAPH}/oauth/access_token`, {
    params: { client_id: APP_ID, client_secret: APP_SECRET, redirect_uri: redirectUri, code },
  });
  return data.access_token;
}

async function getLongLivedToken(shortToken) {
  const { data } = await axios.get(`${GRAPH}/oauth/access_token`, {
    params: {
      grant_type:        "fb_exchange_token",
      client_id:         APP_ID,
      client_secret:     APP_SECRET,
      fb_exchange_token: shortToken,
    },
  });
  const expiresAt = data.expires_in
    ? new Date(Date.now() + data.expires_in * 1000)
    : null;
  return { token: data.access_token, expiresAt };
}

// Fetch Facebook Pages + their linked Instagram Business Accounts
async function getPagesWithInstagram(userToken) {
  const { data } = await axios.get(`${GRAPH}/me/accounts`, {
    params: {
      access_token: userToken,
      fields: "id,name,access_token,instagram_business_account{id,username,name,profile_picture_url,followers_count}",
    },
  });
  const pages = data.data || [];
  const accounts = [];
  for (const page of pages) {
    if (page.instagram_business_account) {
      const ig = page.instagram_business_account;
      accounts.push({
        igAccountId:       ig.id,
        username:          ig.username || "",
        displayName:       ig.name || page.name,
        profilePictureUrl: ig.profile_picture_url || "",
        followersCount:    ig.followers_count || 0,
        pageId:            page.id,
        pageName:          page.name,
        pageAccessToken:   page.access_token,
      });
    }
  }
  return accounts;
}

async function subscribeToWebhook(pageId, pageAccessToken) {
  await axios.post(
    `${GRAPH}/${pageId}/subscribed_apps`,
    {},
    {
      params: {
        access_token:      pageAccessToken,
        subscribed_fields: "messages,messaging_postbacks",
      },
    }
  );
}

// Find which tenant owns a given Instagram account ID (for webhook routing)
async function findTenantByIgAccountId(igAccountId) {
  const tenants = await Tenant.find().lean();
  for (const tenant of tenants) {
    try {
      const conn = await getTenantDB(tenant.dbName);
      const { InstagramIntegration } = getTenantModels(conn);
      const integration = await InstagramIntegration.findOne({
        igAccountId,
        status: "active",
      }).lean();
      if (integration) return { tenant, conn, integration };
    } catch (_) {}
  }
  return null;
}

// Emit a socket event to all connected users of a tenant
async function emitToTenant(conn, event, payload) {
  try {
    const { User } = getTenantModels(conn);
    const tenantUsers = await User.find({}, "_id").lean();
    for (const u of tenantUsers) {
      const sockets = connectedUsers[String(u._id)];
      if (sockets?.length) sockets.forEach((s) => s.emit(event, payload));
    }
  } catch (_) {}
}

// ── Auth & Connect ─────────────────────────────────────────────────────────────

export async function getAuthUrl(req, res) {
  try {
    const { tenantSlug } = req.params;
    const redirectUri = `${process.env.FRONTEND_URL}/integrations/instagram/callback`;

    const url =
      `https://www.facebook.com/v21.0/dialog/oauth` +
      `?client_id=${APP_ID}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=instagram_basic,instagram_manage_messages,instagram_manage_comments,pages_show_list,pages_read_engagement,pages_manage_metadata,pages_messaging` +
      `&response_type=code` +
      `&state=${tenantSlug}`;

    res.json({ success: true, url });
  } catch (err) {
    console.error("Instagram getAuthUrl error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

// Step 1: exchange OAuth code → return list of IG accounts to pick from
export async function handleCallback(req, res) {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, message: "Authorization code is required." });

    const redirectUri = `${process.env.FRONTEND_URL}/integrations/instagram/callback`;

    const shortToken = await exchangeCodeForToken(code, redirectUri);
    const { token: longToken, expiresAt } = await getLongLivedToken(shortToken);

    const accounts = await getPagesWithInstagram(longToken);

    if (!accounts.length) {
      return res.status(400).json({
        success: false,
        message:
          "No Instagram Business Account found. Make sure your Instagram account is a Business or Creator account and is linked to a Facebook Page in Meta Business Suite.",
      });
    }

    res.json({
      success: true,
      selectAccount: true,
      accounts,
      userToken:      longToken,
      tokenExpiresAt: expiresAt,
    });
  } catch (err) {
    console.error("Instagram callback error:", err.response?.data || err.message);
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ success: false, message: msg });
  }
}

// Step 2: save the chosen Instagram account + subscribe webhook
export async function confirmAccount(req, res) {
  try {
    const {
      userToken, tokenExpiresAt,
      igAccountId, pageId, pageAccessToken,
      username, displayName, profilePictureUrl,
    } = req.body;

    if (!userToken || !igAccountId || !pageId) {
      return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    const { InstagramIntegration } = getTenantModels(req.tenantDB);

    const existing = await InstagramIntegration.findOne({ igAccountId, status: "active" });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "This Instagram account is already connected to this CRM.",
      });
    }

    // Subscribe Facebook Page to Instagram events (DMs, comments) via Messenger Platform
    try {
      await subscribeToWebhook(pageId, pageAccessToken);
      console.log("Instagram webhook subscription successful for page:", pageId);
    } catch (subErr) {
      console.warn("Instagram webhook subscription warning:", subErr.response?.data || subErr.message);
    }

    // Subscribe Facebook Page to leadgen events so lead form fills route to /webhooks/meta
    if (pageId && pageAccessToken) {
      try {
        await axios.post(
          `${GRAPH}/${pageId}/subscribed_apps`,
          {},
          { params: { access_token: pageAccessToken, subscribed_fields: "leadgen" } }
        );
      } catch (subErr) {
        console.warn("Instagram page leadgen subscription warning:", subErr.response?.data || subErr.message);
      }
    }

    const integration = await InstagramIntegration.create({
      igAccountId,
      pageId,
      username:          username || "",
      displayName:       displayName || "",
      profilePictureUrl: profilePictureUrl || "",
      accessToken:       userToken,
      tokenExpiresAt:    tokenExpiresAt ? new Date(tokenExpiresAt) : null,
      pageAccessToken:   pageAccessToken || "",
      status:            "active",
      webhookSubscribed: true,
      connectedBy:       req.user._id,
    });

    res.json({ success: true, integration });
  } catch (err) {
    console.error("Instagram confirmAccount error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

// ── Integration management ─────────────────────────────────────────────────────

export async function getIntegrations(req, res) {
  try {
    const { InstagramIntegration } = getTenantModels(req.tenantDB);
    const integrations = await InstagramIntegration.find({ status: "active" })
      .populate("connectedBy", "name email")
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, integrations });
  } catch (err) {
    console.error("Instagram getIntegrations error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function disconnect(req, res) {
  try {
    const { id } = req.params;
    const { InstagramIntegration } = getTenantModels(req.tenantDB);

    const integration = await InstagramIntegration.findById(id);
    if (!integration) return res.status(404).json({ success: false, message: "Integration not found." });

    try {
      await axios.delete(`${GRAPH}/${integration.igAccountId}/subscribed_apps`, {
        params: { access_token: integration.accessToken },
      });
    } catch (_) {}

    integration.status = "disconnected";
    await integration.save();

    res.json({ success: true, message: "Instagram integration disconnected." });
  } catch (err) {
    console.error("Instagram disconnect error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function refreshToken(req, res) {
  try {
    const { id } = req.params;
    const { InstagramIntegration } = getTenantModels(req.tenantDB);

    const integration = await InstagramIntegration.findById(id);
    if (!integration) return res.status(404).json({ success: false, message: "Integration not found." });

    const { token, expiresAt } = await getLongLivedToken(integration.accessToken);
    integration.accessToken    = token;
    integration.tokenExpiresAt = expiresAt;
    await integration.save();

    res.json({ success: true, message: "Token refreshed.", tokenExpiresAt: expiresAt });
  } catch (err) {
    console.error("Instagram refreshToken error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

// ── DM Conversations & Messages ───────────────────────────────────────────────

export async function getConversations(req, res) {
  try {
    const { integrationId } = req.query;
    const { InstagramIntegration, InstagramMessage } = getTenantModels(req.tenantDB);

    let integration;
    if (integrationId) {
      integration = await InstagramIntegration.findById(integrationId);
    } else {
      integration = await InstagramIntegration.findOne({ status: "active" });
    }
    if (!integration) return res.json({ success: true, conversations: [] });

    // Latest message per contact
    const conversations = await InstagramMessage.aggregate([
      { $match: { igAccountId: integration.igAccountId } },
      { $sort:  { createdAt: -1 } },
      {
        $group: {
          _id:              "$senderIgsid",
          senderUsername:   { $max: "$senderUsername" },
          senderName:       { $max: "$senderName" },
          senderProfilePic: { $max: "$senderProfilePic" },
          lastMessage:      { $first: "$body" },
          lastMessageType:  { $first: "$type" },
          lastMessageTime:  { $first: "$createdAt" },
          lastDirection:    { $first: "$direction" },
          lastStatus:       { $first: "$status" },
        },
      },
      { $sort: { lastMessageTime: -1 } },
      { $limit: 100 },
    ]);

    const unreadCounts = await InstagramMessage.aggregate([
      { $match: { igAccountId: integration.igAccountId, direction: "inbound", read: false } },
      { $group: { _id: "$senderIgsid", count: { $sum: 1 } } },
    ]);
    const unreadMap = {};
    unreadCounts.forEach((u) => { unreadMap[u._id] = u.count; });

    // Enrich with leadId if a matching lead exists
    let result = conversations.map((c) => ({
      senderIgsid:      c._id,
      senderUsername:   c.senderUsername || c._id,
      senderName:       c.senderName || c.senderUsername || c._id,
      senderProfilePic: c.senderProfilePic || "",
      lastMessage:      c.lastMessage,
      lastMessageType:  c.lastMessageType,
      lastMessageTime:  c.lastMessageTime,
      lastDirection:    c.lastDirection,
      unreadCount:      unreadMap[c._id] || 0,
    }));

    try {
      const { Lead } = getTenantModels(req.tenantDB);
      const leads = await Lead.find({ instagramUsername: { $exists: true, $ne: "" } }, "_id leadName instagramUsername").lean();
      const usernameToLead = {};
      for (const lead of leads) {
        if (lead.instagramUsername) usernameToLead[lead.instagramUsername.replace("@", "")] = { leadId: lead._id, leadName: lead.leadName };
      }
      result = result.map((c) => ({
        ...c,
        ...(usernameToLead[c.senderUsername?.replace("@", "")] || {}),
      }));
    } catch (_) {}

    res.json({ success: true, conversations: result, integration });
  } catch (err) {
    console.error("Instagram getConversations error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function getMessages(req, res) {
  try {
    const { senderIgsid } = req.params;
    const { integrationId, page = 1, limit = 50 } = req.query;

    const { InstagramIntegration, InstagramMessage } = getTenantModels(req.tenantDB);

    let integration;
    if (integrationId) {
      integration = await InstagramIntegration.findById(integrationId);
    } else {
      integration = await InstagramIntegration.findOne({ status: "active" });
    }
    if (!integration) return res.status(400).json({ success: false, message: "No active Instagram integration found." });

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const messages = await InstagramMessage.find({
      igAccountId: integration.igAccountId,
      senderIgsid,
    })
      .populate("sentBy", "name email")
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    const total = await InstagramMessage.countDocuments({
      igAccountId: integration.igAccountId,
      senderIgsid,
    });

    res.json({ success: true, messages, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error("Instagram getMessages error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function markAsRead(req, res) {
  try {
    const { senderIgsid } = req.params;
    const { integrationId } = req.body;

    const { InstagramIntegration, InstagramMessage } = getTenantModels(req.tenantDB);

    let integration;
    if (integrationId) {
      integration = await InstagramIntegration.findById(integrationId);
    } else {
      integration = await InstagramIntegration.findOne({ status: "active" });
    }
    if (!integration) return res.status(400).json({ success: false, message: "No active Instagram integration found." });

    const result = await InstagramMessage.updateMany(
      { igAccountId: integration.igAccountId, senderIgsid, direction: "inbound", read: false },
      { $set: { read: true } }
    );

    res.json({ success: true, updated: result.modifiedCount });
  } catch (err) {
    console.error("Instagram markAsRead error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

// ── Send DM ───────────────────────────────────────────────────────────────────

export async function sendMessage(req, res) {
  try {
    const { integrationId, to, message } = req.body;

    if (!to || !message?.trim()) {
      return res.status(400).json({ success: false, message: "'to' (senderIgsid) and 'message' are required." });
    }

    const { InstagramIntegration, InstagramMessage } = getTenantModels(req.tenantDB);

    let integration;
    if (integrationId) {
      integration = await InstagramIntegration.findById(integrationId);
    } else {
      integration = await InstagramIntegration.findOne({ status: "active" });
    }
    if (!integration) return res.status(400).json({ success: false, message: "No active Instagram integration found." });

    const { data } = await axios.post(
      `${GRAPH}/${integration.pageId}/messages`,
      {
        recipient:         { id: to },
        message:           { text: message.trim() },
        messaging_type:    "RESPONSE",
      },
      { params: { access_token: integration.pageAccessToken } }
    );

    const saved = await InstagramMessage.create({
      igAccountId:  integration.igAccountId,
      messageId:    data.message_id || null,
      senderIgsid:  to,
      direction:    "outbound",
      type:         "text",
      body:         message.trim(),
      status:       "sent",
      sentBy:       req.user._id,
      igTimestamp:  new Date(),
    });

    res.json({ success: true, message: saved });
  } catch (err) {
    console.error("Instagram sendMessage error:", err.response?.data || err.message);
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ success: false, message: msg });
  }
}

export async function sendMedia(req, res) {
  try {
    const { integrationId, to, caption = "" } = req.body;
    const file = req.file;

    if (!file) return res.status(400).json({ success: false, message: "No file uploaded." });
    if (!to)   return res.status(400).json({ success: false, message: "'to' (senderIgsid) is required." });

    const { InstagramIntegration, InstagramMessage } = getTenantModels(req.tenantDB);

    let integration;
    if (integrationId) {
      integration = await InstagramIntegration.findById(integrationId);
    } else {
      integration = await InstagramIntegration.findOne({ status: "active" });
    }
    if (!integration) return res.status(400).json({ success: false, message: "No active Instagram integration found." });

    const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`;
    const relativePath = `/uploads/instagram/${file.filename}`;
    const publicUrl    = `${BACKEND_URL}${relativePath}`;

    let attachmentType = "file";
    if (file.mimetype.startsWith("image/")) attachmentType = "image";
    else if (file.mimetype.startsWith("video/")) attachmentType = "video";
    else if (file.mimetype.startsWith("audio/")) attachmentType = "audio";

    const { data } = await axios.post(
      `${GRAPH}/${integration.pageId}/messages`,
      {
        recipient: { id: to },
        message: {
          attachment: {
            type:    attachmentType,
            payload: { url: publicUrl, is_reusable: true },
          },
        },
        messaging_type: "RESPONSE",
      },
      { params: { access_token: integration.pageAccessToken } }
    );

    const saved = await InstagramMessage.create({
      igAccountId:   integration.igAccountId,
      messageId:     data.message_id || null,
      senderIgsid:   to,
      direction:     "outbound",
      type:          attachmentType,
      body:          caption,
      mediaUrl:      relativePath,
      mediaMimeType: file.mimetype,
      mediaFilename: file.originalname,
      status:        "sent",
      sentBy:        req.user._id,
      igTimestamp:   new Date(),
    });

    res.json({ success: true, message: saved });
  } catch (err) {
    console.error("Instagram sendMedia error:", err.response?.data || err.message);
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ success: false, message: msg });
  }
}

// ── Post Comments ─────────────────────────────────────────────────────────────

export async function getPostComments(req, res) {
  try {
    const { integrationId, page = 1, limit = 50 } = req.query;
    const { InstagramIntegration, InstagramComment } = getTenantModels(req.tenantDB);

    let integration;
    if (integrationId) {
      integration = await InstagramIntegration.findById(integrationId);
    } else {
      integration = await InstagramIntegration.findOne({ status: "active" });
    }
    if (!integration) return res.json({ success: true, comments: [] });

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const comments = await InstagramComment.find({
      igAccountId:     integration.igAccountId,
      parentCommentId: null,
      isDeleted:       false,
    })
      .sort({ igTimestamp: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    const total = await InstagramComment.countDocuments({
      igAccountId:     integration.igAccountId,
      parentCommentId: null,
      isDeleted:       false,
    });

    res.json({ success: true, comments, total });
  } catch (err) {
    console.error("Instagram getPostComments error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function replyToComment(req, res) {
  try {
    const { commentId } = req.params;
    const { message, integrationId } = req.body;

    if (!message?.trim()) return res.status(400).json({ success: false, message: "Reply message is required." });

    const { InstagramIntegration, InstagramComment } = getTenantModels(req.tenantDB);

    let integration;
    if (integrationId) {
      integration = await InstagramIntegration.findById(integrationId);
    } else {
      integration = await InstagramIntegration.findOne({ status: "active" });
    }
    if (!integration) return res.status(400).json({ success: false, message: "No active Instagram integration found." });

    await axios.post(
      `${GRAPH}/${commentId}/replies`,
      { message: message.trim() },
      { params: { access_token: integration.accessToken } }
    );

    await InstagramComment.findOneAndUpdate(
      { commentId },
      { $set: { replied: true, replyText: message.trim() } }
    );

    res.json({ success: true, message: "Reply posted." });
  } catch (err) {
    console.error("Instagram replyToComment error:", err.response?.data || err.message);
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ success: false, message: msg });
  }
}

export async function hideComment(req, res) {
  try {
    const { commentId } = req.params;
    const { integrationId, hidden } = req.body;

    const { InstagramIntegration, InstagramComment } = getTenantModels(req.tenantDB);

    let integration;
    if (integrationId) {
      integration = await InstagramIntegration.findById(integrationId);
    } else {
      integration = await InstagramIntegration.findOne({ status: "active" });
    }
    if (!integration) return res.status(400).json({ success: false, message: "No active Instagram integration found." });

    await axios.post(
      `${GRAPH}/${commentId}`,
      { hide: !!hidden },
      { params: { access_token: integration.accessToken } }
    );

    await InstagramComment.findOneAndUpdate({ commentId }, { $set: { isHidden: !!hidden } });

    res.json({ success: true });
  } catch (err) {
    console.error("Instagram hideComment error:", err.response?.data || err.message);
    res.status(500).json({ success: false, message: err.response?.data?.error?.message || err.message });
  }
}

export async function deleteComment(req, res) {
  try {
    const { commentId } = req.params;
    const { integrationId } = req.body;

    const { InstagramIntegration, InstagramComment } = getTenantModels(req.tenantDB);

    let integration;
    if (integrationId) {
      integration = await InstagramIntegration.findById(integrationId);
    } else {
      integration = await InstagramIntegration.findOne({ status: "active" });
    }
    if (!integration) return res.status(400).json({ success: false, message: "No active Instagram integration found." });

    await axios.delete(`${GRAPH}/${commentId}`, {
      params: { access_token: integration.accessToken },
    });

    await InstagramComment.findOneAndUpdate({ commentId }, { $set: { isDeleted: true } });

    res.json({ success: true });
  } catch (err) {
    console.error("Instagram deleteComment error:", err.response?.data || err.message);
    res.status(500).json({ success: false, message: err.response?.data?.error?.message || err.message });
  }
}

// ── Sync posts + comments from IG API (manual refresh) ───────────────────────

export async function syncComments(req, res) {
  try {
    const { integrationId } = req.query;
    const { InstagramIntegration, InstagramComment } = getTenantModels(req.tenantDB);

    let integration;
    if (integrationId) {
      integration = await InstagramIntegration.findById(integrationId);
    } else {
      integration = await InstagramIntegration.findOne({ status: "active" });
    }
    if (!integration) return res.status(400).json({ success: false, message: "No active Instagram integration found." });

    // Fetch recent posts (last 20) — photos, videos, reels
    const { data: mediaData } = await axios.get(`${GRAPH}/${integration.igAccountId}/media`, {
      params: {
        access_token: integration.accessToken,
        fields: "id,caption,timestamp,media_type,thumbnail_url,media_url",
        limit: 20,
      },
    });

    const posts = mediaData.data || [];
    const organicPostIds = new Set(posts.map((p) => p.id));
    let synced = 0;

    const commentFields = "id,text,timestamp,from,like_count,hidden,replies{id,text,timestamp,from}";

    const saveComments = async (comments, post, isAd = false, adId = null) => {
      for (const comment of comments) {
        await InstagramComment.findOneAndUpdate(
          { commentId: comment.id },
          {
            $setOnInsert: {
              igAccountId:     integration.igAccountId,
              postId:          post.id,
              postCaption:     post.caption || "",
              postMediaUrl:    post.media_url || post.thumbnail_url || "",
              postMediaType:   post.media_type || "IMAGE",
              commentId:       comment.id,
              parentCommentId: null,
              senderUsername:  comment.from?.username || "",
              senderIgsid:     comment.from?.id || "",
              text:            comment.text || "",
              isHidden:        comment.hidden || false,
              isAd,
              adId,
              igTimestamp:     comment.timestamp ? new Date(comment.timestamp) : new Date(),
            },
          },
          { upsert: true, new: false }
        );
        synced++;

        for (const reply of comment.replies?.data || []) {
          await InstagramComment.findOneAndUpdate(
            { commentId: reply.id },
            {
              $setOnInsert: {
                igAccountId:     integration.igAccountId,
                postId:          post.id,
                commentId:       reply.id,
                parentCommentId: comment.id,
                senderUsername:  reply.from?.username || "",
                senderIgsid:     reply.from?.id || "",
                text:            reply.text || "",
                isAd,
                adId,
                igTimestamp:     reply.timestamp ? new Date(reply.timestamp) : new Date(),
              },
            },
            { upsert: true, new: false }
          );
        }
      }
    };

    // ── 1. Organic posts / reels ──────────────────────────────────────────────
    for (const post of posts) {
      try {
        const { data: commentData } = await axios.get(`${GRAPH}/${post.id}/comments`, {
          params: { access_token: integration.accessToken, fields: commentFields, limit: 50 },
        });
        await saveComments(commentData.data || [], post);
      } catch (postErr) {
        console.warn(`Instagram syncComments post ${post.id} error:`, postErr.message);
      }
    }

    // ── 2. Ad (dark-post) comments via Ads API ────────────────────────────────
    // Requires ads_read permission — skipped gracefully if not granted
    try {
      const { data: adAccountsData } = await axios.get(`${GRAPH}/${integration.pageId}/adaccounts`, {
        params: { access_token: integration.accessToken, fields: "id" },
      });

      const seenAdPostIds = new Set();

      for (const adAccount of (adAccountsData.data || [])) {
        let adsData;
        try {
          ({ data: adsData } = await axios.get(`${GRAPH}/${adAccount.id}/ads`, {
            params: {
              access_token: integration.accessToken,
              fields: "id,creative{object_story_id}",
              effective_status: JSON.stringify(["ACTIVE", "PAUSED", "ARCHIVED"]),
              limit: 50,
            },
          }));
        } catch (adFetchErr) {
          console.warn(`Instagram syncComments adAccount ${adAccount.id}:`, adFetchErr.response?.data?.error?.message || adFetchErr.message);
          continue;
        }

        for (const ad of (adsData.data || [])) {
          const storyId = ad.creative?.object_story_id; // format: "{pageId}_{postId}"
          if (!storyId || seenAdPostIds.has(storyId)) continue;
          seenAdPostIds.add(storyId);

          try {
            // Resolve to Instagram media ID
            const { data: storyData } = await axios.get(`${GRAPH}/${storyId}`, {
              params: { access_token: integration.pageAccessToken || integration.accessToken, fields: "instagram_media_id" },
            });

            const igMediaId = storyData.instagram_media_id;
            if (!igMediaId || organicPostIds.has(igMediaId)) continue; // skip if already synced as organic

            const { data: commentData } = await axios.get(`${GRAPH}/${igMediaId}/comments`, {
              params: { access_token: integration.accessToken, fields: commentFields, limit: 50 },
            });

            await saveComments(commentData.data || [], { id: igMediaId, caption: "", media_url: "", media_type: "AD" }, true, ad.id);
          } catch (adPostErr) {
            console.warn(`Instagram syncComments ad ${ad.id} media error:`, adPostErr.message);
          }
        }
      }
    } catch (adsErr) {
      // ads_read not granted — silently skip ad sync
      console.warn("Instagram syncComments ads (ads_read not available):", adsErr.response?.data?.error?.message || adsErr.message);
    }

    res.json({ success: true, synced, postsChecked: posts.length });
  } catch (err) {
    console.error("Instagram syncComments error:", err.response?.data || err.message);
    res.status(500).json({ success: false, message: err.response?.data?.error?.message || err.message });
  }
}

// ── Webhook ───────────────────────────────────────────────────────────────────

export function verifyWebhook(req, res) {
  const mode      = req.query["hub.mode"]      || req.query.hub_mode;
  const token     = req.query["hub.verify_token"] || req.query.hub_verify_token;
  const challenge = req.query["hub.challenge"] || req.query.hub_challenge;

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Instagram webhook verified");
    return res.status(200).send(challenge);
  }
  res.status(403).json({ message: "Instagram webhook verification failed." });
}

export async function receiveWebhook(req, res) {
  res.sendStatus(200); // always ack within 5s

  try {
    const body = req.body;
    console.log("Instagram webhook received:", JSON.stringify(body).slice(0, 200));
    if (body.object !== "instagram") return;

    for (const entry of body.entry || []) {
      const igAccountId = entry.id;

      // Messaging events (DMs)
      for (const messaging of entry.messaging || []) {
        await processIncomingDM(igAccountId, messaging).catch((e) =>
          console.error("Instagram processIncomingDM error:", e.message)
        );
      }

      // Changes (comments, mentions, story mentions)
      for (const change of entry.changes || []) {
        if (change.field === "comments") {
          await processComment(igAccountId, change.value).catch((e) =>
            console.error("Instagram processComment error:", e.message)
          );
        }
        if (change.field === "mentions") {
          await processMention(igAccountId, change.value).catch((e) =>
            console.error("Instagram processMention error:", e.message)
          );
        }
      }
    }
  } catch (err) {
    console.error("Instagram receiveWebhook error:", err.message);
  }
}

// ── Internal webhook processors ───────────────────────────────────────────────

async function processIncomingDM(igAccountId, messaging) {
  // Ignore echo (our own outbound messages echoed back)
  if (messaging.message?.is_echo) return;
  // Ignore read receipts in messaging events
  if (messaging.read) {
    await processReadReceipt(igAccountId, messaging);
    return;
  }
  // Ignore delivery events
  if (messaging.delivery) return;

  console.log(`Instagram DM received: igAccountId=${igAccountId}, sender=${messaging.sender?.id}`);
  const result = await findTenantByIgAccountId(igAccountId);
  if (!result) {
    console.warn(`Instagram: no tenant found for igAccountId=${igAccountId}`);
    return;
  }
  console.log(`Instagram DM: tenant found, processing message...`);

  const { conn, integration } = result;
  const { InstagramMessage } = getTenantModels(conn);

  const senderIgsid = messaging.sender?.id;
  if (!senderIgsid || senderIgsid === igAccountId) return; // skip own messages

  const msgId = messaging.message?.mid;

  // Dedup
  if (msgId) {
    const exists = await InstagramMessage.findOne({ messageId: msgId });
    if (exists) return;
  }

  // Parse message content
  let type = "text";
  let body = "";
  let mediaUrl = null;
  let mediaId  = null;
  let mediaMimeType = null;
  let storyUrl = null;
  let storyId  = null;
  let reactionEmoji = null;
  let reactionTargetMessageId = null;

  const msg = messaging.message || {};

  if (msg.text) {
    body = msg.text;
  } else if (msg.attachments?.length) {
    const att = msg.attachments[0];
    console.log("Instagram attachment:", JSON.stringify(att));
    if (att.type === "image")  { type = "image";  mediaUrl = att.payload?.url; }
    else if (att.type === "video")  { type = "video";  mediaUrl = att.payload?.url; }
    else if (att.type === "audio")  { type = "audio";  mediaUrl = att.payload?.url; }
    else if (att.type === "file")   { type = "file";   mediaUrl = att.payload?.url; }
    else if (att.type === "story_mention") {
      type     = "story_mention";
      storyUrl = att.payload?.url;
      storyId  = att.payload?.story_id || null;
      body     = "Mentioned you in their story";
    } else if (att.type === "ig_reel") {
      type     = "reel";
      mediaUrl = att.payload?.url;
      body     = "Shared a reel";
    } else if (att.type === "ig_post") {
      type     = "ig_post";
      mediaUrl = att.payload?.url;
      body     = att.payload?.title ? att.payload.title.slice(0, 100) : "Shared a post";
    } else {
      type = "unsupported";
      body = `[${att.type}]`;
    }
  } else if (messaging.reaction) {
    type = "reaction";
    reactionEmoji = messaging.reaction.emoji;
    reactionTargetMessageId = messaging.reaction.mid;
    body = messaging.reaction.emoji || "❤️";
  } else {
    type = "unsupported";
    body = "[Unsupported message type]";
  }

  // Try to get sender's username from the integration's IG account
  let senderUsername = "";
  let senderName     = "";
  let senderProfilePic = "";
  try {
    const { data: profile } = await axios.get(`${GRAPH}/${senderIgsid}`, {
      params: { access_token: integration.pageAccessToken, fields: "name,username,profile_pic" },
    });
    console.log("Instagram sender profile response:", JSON.stringify(profile));
    senderUsername   = profile.username   || "";
    senderName       = profile.name       || "";
    senderProfilePic = profile.profile_pic || "";
  } catch (profileErr) {
    console.warn("Instagram: could not fetch sender profile:", profileErr.response?.data?.error?.message || profileErr.message);
  }

  const igTimestamp = messaging.timestamp
    ? new Date(messaging.timestamp)
    : new Date();

  const saved = await InstagramMessage.create({
    igAccountId,
    messageId:    msgId,
    senderIgsid,
    senderUsername,
    senderName,
    senderProfilePic,
    direction:    "inbound",
    type,
    body,
    mediaUrl,
    mediaId,
    mediaMimeType,
    storyUrl,
    storyId,
    reactionEmoji,
    reactionTargetMessageId,
    status:       "delivered",
    read:         false,
    igTimestamp,
  });

  console.log(`Instagram DM saved: from=${senderUsername || senderIgsid}, text="${body.slice(0, 50)}"`);
  await emitToTenant(conn, "instagram:message", {
    message:       saved,
    senderIgsid,
    senderUsername,
    igAccountId,
    integrationId: integration._id,
  });
}

async function processReadReceipt(igAccountId, messaging) {
  const result = await findTenantByIgAccountId(igAccountId);
  if (!result) return;
  const { conn } = result;
  const { InstagramMessage } = getTenantModels(conn);

  const watermark = messaging.read?.watermark;
  if (!watermark) return;

  // Mark all our outbound messages up to this timestamp as "seen"
  await InstagramMessage.updateMany(
    {
      igAccountId,
      senderIgsid: messaging.sender?.id,
      direction:   "outbound",
      status:      { $in: ["sent", "delivered"] },
      igTimestamp: { $lte: new Date(watermark) },
    },
    { $set: { status: "seen", statusUpdatedAt: new Date() } }
  );

  await emitToTenant(conn, "instagram:status", {
    igAccountId,
    senderIgsid: messaging.sender?.id,
    status:      "seen",
    watermark,
  });
}

async function processComment(igAccountId, value) {
  const result = await findTenantByIgAccountId(igAccountId);
  if (!result) return;

  const { conn, integration } = result;
  const { InstagramComment } = getTenantModels(conn);

  const commentId = value.id;
  const postId    = value.media?.id;

  if (!commentId || !postId) return;

  // Dedup
  const exists = await InstagramComment.findOne({ commentId });
  if (exists) return;

  const saved = await InstagramComment.create({
    igAccountId,
    postId,
    commentId,
    parentCommentId: value.parent_id || null,
    senderUsername:  value.from?.username || "",
    senderIgsid:     value.from?.id || "",
    text:            value.text || "",
    igTimestamp:     new Date(),
  });

  await emitToTenant(conn, "instagram:comment", {
    comment:      saved,
    igAccountId,
    integrationId: integration._id,
  });
}

async function processMention(igAccountId, value) {
  const result = await findTenantByIgAccountId(igAccountId);
  if (!result) return;

  const { conn, integration } = result;

  await emitToTenant(conn, "instagram:mention", {
    igAccountId,
    mediaId:       value.media_id,
    commentId:     value.comment_id,
    integrationId: integration._id,
  });
}
