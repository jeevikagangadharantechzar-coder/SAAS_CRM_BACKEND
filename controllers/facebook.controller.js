import axios from "axios";
import { getTenantModels, registerTenantModels } from "../models/tenant/index.js";
import { getTenantDB } from "../config/tenantDB.js";
import Tenant from "../models/master/Tenant.js";
import { connectedUsers } from "../realtime/socket.js";

const GRAPH = "https://graph.facebook.com/v21.0";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getActiveIntegration(req) {
  const { MetaIntegration } = getTenantModels(req.tenantDB);
  return MetaIntegration.findOne({ status: "active" });
}

async function findTenantByPageId(pageId) {
  const tenants = await Tenant.find({ status: "active" }).lean();
  for (const tenant of tenants) {
    try {
      const conn = await getTenantDB(tenant.slug);
      registerTenantModels(conn);
      const { MetaIntegration } = getTenantModels(conn);
      const integ = await MetaIntegration.findOne({ facebookPageId: pageId, status: "active" });
      if (integ) return { conn, integration: integ };
    } catch (_) { }
  }
  return null;
}

async function emitToTenant(conn, event, payload) {
  try {
    const { User } = getTenantModels(conn);
    const users = await User.find({}, "_id").lean();
    for (const u of users) {
      const sockets = connectedUsers[String(u._id)];
      if (sockets?.length) sockets.forEach((s) => s.emit(event, payload));
    }
  } catch (_) { }
}

// ── Messenger ─────────────────────────────────────────────────────────────────

export async function getConversations(req, res) {
  try {
    const { FacebookMessage, MetaIntegration } = getTenantModels(req.tenantDB);
    const { integrationId } = req.query;
    const integration = integrationId
      ? await MetaIntegration.findById(integrationId)
      : await getActiveIntegration(req);
    if (!integration) return res.json({ success: true, conversations: [] });

    const conversations = await FacebookMessage.aggregate([
      { $match: { pageId: integration.facebookPageId } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$senderPsid",
          senderPsid: { $first: "$senderPsid" },
          senderName: { $first: "$senderName" },
          senderProfilePic: { $first: "$senderProfilePic" },
          lastMessage: { $first: "$body" },
          lastMessageType: { $first: "$type" },
          lastMessageAt: { $first: "$fbTimestamp" },
          lastMessageDirection: { $first: "$direction" },
          unreadCount: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ["$direction", "inbound"] }, { $eq: ["$read", false] }] },
                1, 0,
              ],
            },
          },
          leadId: { $first: "$leadId" },
        },
      },
      { $sort: { lastMessageAt: -1 } },
    ]);

    res.json({ success: true, conversations });
  } catch (err) {
    console.error("Facebook getConversations error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function getMessages(req, res) {
  try {
    const { senderPsid } = req.params;
    const { FacebookMessage, MetaIntegration } = getTenantModels(req.tenantDB);
    const { integrationId } = req.query;
    const integration = integrationId
      ? await MetaIntegration.findById(integrationId)
      : await getActiveIntegration(req);
    if (!integration) return res.json({ success: true, messages: [] });

    const messages = await FacebookMessage.find({
      pageId: integration.facebookPageId,
      senderPsid,
    })
      .sort({ fbTimestamp: 1, createdAt: 1 })
      .lean();

    await FacebookMessage.updateMany(
      { pageId: integration.facebookPageId, senderPsid, direction: "inbound", read: false },
      { $set: { read: true } }
    );

    res.json({ success: true, messages });
  } catch (err) {
    console.error("Facebook getMessages error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function syncConversations(req, res) {
  try {
    const { integrationId } = req.query;
    const { MetaIntegration, FacebookMessage } = getTenantModels(req.tenantDB);

    const integration = integrationId
      ? await MetaIntegration.findById(integrationId)
      : await MetaIntegration.findOne({ status: "active" });
    if (!integration) return res.status(400).json({ success: false, message: "No active Facebook Page connected" });

    // Fetch conversations from Graph API
    const { data } = await axios.get(`${GRAPH}/${integration.facebookPageId}/conversations`, {
      params: {
        access_token: integration.pageAccessToken,
        fields: "id,updated_time,participants,messages.limit(20){id,message,created_time,from,to,attachments}",
        limit: 50,
      },
    });

    const conversations = data.data || [];
    let syncedMsgs = 0;

    for (const conv of conversations) {
      // The person we are talking to (not the page)
      const participant = conv.participants?.data?.find((p) => p.id !== integration.facebookPageId) || {};
      const senderPsid = participant.id;
      const senderName = participant.name || "Unknown";

      if (!senderPsid) continue;

      for (const msg of conv.messages?.data || []) {
        const isOutbound = msg.from?.id === integration.facebookPageId;

        let type = "text";
        let body = msg.message || "";
        let mediaUrl = null;

        if (msg.attachments?.data?.length) {
          const att = msg.attachments.data[0];
          if (att.image_data) { type = "image"; mediaUrl = att.image_data.url; body = body || "[Image]"; }
          else if (att.video_data) { type = "video"; mediaUrl = att.video_data.url; body = body || "[Video]"; }
          else { type = "file"; body = body || "[File]"; }
        }

        await FacebookMessage.findOneAndUpdate(
          { messageId: msg.id },
          {
            $setOnInsert: {
              pageId: integration.facebookPageId,
              messageId: msg.id,
              senderPsid,
              senderName,
              direction: isOutbound ? "outbound" : "inbound",
              type,
              body,
              mediaUrl,
              fbTimestamp: msg.created_time ? new Date(msg.created_time) : new Date(),
            },
            $set: {
              status: isOutbound ? "sent" : "delivered",
              read: true,
            },
          },
          { upsert: true, new: false }
        );
        syncedMsgs++;
      }
    }

    res.json({ success: true, message: `Synced ${conversations.length} conversations`, syncedMsgs });
  } catch (err) {
    console.error("Facebook syncConversations error:", err.response?.data || err.message);
    res.status(500).json({ success: false, message: err.response?.data?.error?.message || err.message });
  }
}

export async function sendMessage(req, res) {
  try {
    const { senderPsid, text, integrationId } = req.body;
    if (!text?.trim()) return res.status(400).json({ success: false, message: "Message text is required" });

    const { MetaIntegration, FacebookMessage } = getTenantModels(req.tenantDB);
    const integration = integrationId
      ? await MetaIntegration.findById(integrationId)
      : await MetaIntegration.findOne({ status: "active" });
    if (!integration) return res.status(400).json({ success: false, message: "No active Facebook Page connected" });

    const { data } = await axios.post(
      `${GRAPH}/me/messages`,
      { recipient: { id: senderPsid }, message: { text: text.trim() } },
      { params: { access_token: integration.pageAccessToken } }
    );

    const saved = await FacebookMessage.create({
      pageId: integration.facebookPageId,
      messageId: data.message_id,
      senderPsid,
      direction: "outbound",
      type: "text",
      body: text.trim(),
      status: "sent",
      read: true,
      sentBy: req.user._id,
      fbTimestamp: new Date(),
    });

    res.json({ success: true, message: saved });
  } catch (err) {
    console.error("Facebook sendMessage error:", err.response?.data || err.message);
    res.status(500).json({ success: false, message: err.response?.data?.error?.message || err.message });
  }
}

export async function markRead(req, res) {
  try {
    const { senderPsid } = req.params;
    const { FacebookMessage, MetaIntegration } = getTenantModels(req.tenantDB);
    const { integrationId } = req.query;
    const integration = integrationId
      ? await MetaIntegration.findById(integrationId)
      : await getActiveIntegration(req);
    if (!integration) return res.json({ success: true });

    await FacebookMessage.updateMany(
      { pageId: integration.facebookPageId, senderPsid, direction: "inbound", read: false },
      { $set: { read: true } }
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// ── Comments ──────────────────────────────────────────────────────────────────

export async function getPostComments(req, res) {
  try {
    const { page = 1, limit = 50, integrationId } = req.query;
    const { MetaIntegration, FacebookComment } = getTenantModels(req.tenantDB);

    const integration = integrationId
      ? await MetaIntegration.findById(integrationId)
      : await MetaIntegration.findOne({ status: "active" });
    if (!integration) return res.json({ success: true, comments: [], total: 0 });

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [comments, total] = await Promise.all([
      FacebookComment.find({ pageId: integration.facebookPageId, parentCommentId: null, isDeleted: false })
        .sort({ fbTimestamp: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      FacebookComment.countDocuments({ pageId: integration.facebookPageId, parentCommentId: null, isDeleted: false }),
    ]);

    res.json({ success: true, comments, total });
  } catch (err) {
    console.error("Facebook getPostComments error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function syncComments(req, res) {
  try {
    const { integrationId } = req.query;
    const { MetaIntegration, FacebookComment } = getTenantModels(req.tenantDB);

    const integration = integrationId
      ? await MetaIntegration.findById(integrationId)
      : await MetaIntegration.findOne({ status: "active" });
    if (!integration) return res.status(400).json({ success: false, message: "No active Facebook Page connected" });

    // Use /posts which returns story-level IDs (correct for fetching comments).
    const [feedRes, postsRes] = await Promise.allSettled([
      axios.get(`${GRAPH}/${integration.facebookPageId}/feed`, {
        params: {
          access_token: integration.pageAccessToken,
          fields: "id,message,created_time,attachments{media{image{src}}}",
          limit: 50,
        },
      }),
      axios.get(`${GRAPH}/${integration.facebookPageId}/posts`, {
        params: {
          access_token: integration.pageAccessToken,
          fields: "id,message,created_time,attachments{media{image{src}}}",
          limit: 50,
        },
      }),
    ]);

    const feedPosts = feedRes.status === "fulfilled" ? (feedRes.value.data.data || []) : [];
    const pagePosts = postsRes.status === "fulfilled" ? (postsRes.value.data.data || []) : [];

    const fetchErrors = [];
    if (feedRes.status === "rejected") fetchErrors.push({ error: `Feed error: ${feedRes.reason?.response?.data?.error?.message || feedRes.reason?.message}` });
    if (postsRes.status === "rejected") fetchErrors.push({ error: `Posts error: ${postsRes.reason?.response?.data?.error?.message || postsRes.reason?.message}` });


    // Deduplicate by ID — /posts stories take priority (they have correct story IDs)
    const seenIds = new Set();
    const posts = [];
    for (const post of [...pagePosts, ...feedPosts]) {
      if (!seenIds.has(post.id)) { seenIds.add(post.id); posts.push(post); }
    }

    let synced = 0;
    const postErrors = [];
    const debugPosts = [];

    for (const post of posts) {
      try {
        const { data: commentData } = await axios.get(`${GRAPH}/${post.id}/comments`, {
          params: {
            access_token: integration.pageAccessToken,
            // TODO (Future): Once Meta approves 'pages_read_user_content' in App Review, 
            // change the fields below to include 'from' so you get the commenter's name:
            // fields: "id,message,created_time,from,replies{id,message,created_time,from}",
            fields: "id,message,created_time,replies{id,message,created_time}",
            summary: true,
            limit: 100,
          },
        });

        debugPosts.push({
          postId: post.id,
          message: (post.message || "").substring(0, 50),
          commentsReturned: (commentData.data || []).length,
          totalComments: commentData.summary?.total_count,
        });
        const postMediaUrl = post.attachments?.data?.[0]?.media?.image?.src || "";

        for (const comment of commentData.data || []) {
          console.log(`Debug Comment ID ${comment.id}:`, JSON.stringify(comment));
          await FacebookComment.findOneAndUpdate(
            { commentId: comment.id },
            {
              $setOnInsert: {
                pageId: integration.facebookPageId,
                postId: post.id,
                postMessage: post.message || "",
                postMediaUrl: postMediaUrl,
                commentId: comment.id,
                parentCommentId: null,
              },
              $set: {
                senderName: comment.from?.name || "Unknown User",
                senderFbId: comment.from?.id || "",
                text: comment.message || "",
                fbTimestamp: comment.created_time ? new Date(comment.created_time) : new Date(),
              },
            },
            { upsert: true, new: false }
          );
          synced++;

          for (const reply of comment.replies?.data || []) {
            await FacebookComment.findOneAndUpdate(
              { commentId: reply.id },
              {
                $setOnInsert: {
                  pageId: integration.facebookPageId,
                  postId: post.id,
                  commentId: reply.id,
                  parentCommentId: comment.id,
                },
                $set: {
                  senderName: reply.from?.name || "Unknown User",
                  senderFbId: reply.from?.id || "",
                  text: reply.message || "",
                  fbTimestamp: reply.created_time ? new Date(reply.created_time) : new Date(),
                }
              },
              { upsert: true, new: false }
            );
          }
        }
      } catch (postErr) {
        const errMsg = postErr.response?.data?.error?.message || postErr.message;
        console.warn(`Facebook syncComments post ${post.id}:`, errMsg);
        postErrors.push({ postId: post.id, error: errMsg });
        debugPosts.push({ postId: post.id, message: (post.message || "").substring(0, 50), error: errMsg });
      }
    }

    res.json({ success: true, synced, postsChecked: posts.length, errors: [...fetchErrors, ...postErrors], debug: debugPosts, pageId: integration.facebookPageId });
  } catch (err) {
    console.error("Facebook syncComments error:", err.response?.data || err.message);
    res.status(500).json({ success: false, message: err.response?.data?.error?.message || err.message });
  }
}

export async function replyToComment(req, res) {
  try {
    const { commentId } = req.params;
    const { message, integrationId } = req.body;
    if (!message?.trim()) return res.status(400).json({ success: false, message: "Reply message is required" });

    const { MetaIntegration, FacebookComment } = getTenantModels(req.tenantDB);
    const integration = integrationId
      ? await MetaIntegration.findById(integrationId)
      : await MetaIntegration.findOne({ status: "active" });
    if (!integration) return res.status(400).json({ success: false, message: "No active Facebook Page connected" });

    await axios.post(
      `${GRAPH}/${commentId}/comments`,
      { message: message.trim() },
      { params: { access_token: integration.pageAccessToken } }
    );

    await FacebookComment.findOneAndUpdate(
      { commentId },
      { $set: { replied: true, replyText: message.trim() } }
    );

    res.json({ success: true, message: "Reply posted" });
  } catch (err) {
    console.error("Facebook replyToComment error:", err.response?.data || err.message);
    res.status(500).json({ success: false, message: err.response?.data?.error?.message || err.message });
  }
}

export async function hideComment(req, res) {
  try {
    const { commentId } = req.params;
    const { integrationId, hidden } = req.body;

    const { MetaIntegration, FacebookComment } = getTenantModels(req.tenantDB);
    const integration = integrationId
      ? await MetaIntegration.findById(integrationId)
      : await MetaIntegration.findOne({ status: "active" });
    if (!integration) return res.status(400).json({ success: false, message: "No active Facebook Page connected" });

    await axios.post(
      `${GRAPH}/${commentId}`,
      { is_hidden: !!hidden },
      { params: { access_token: integration.pageAccessToken } }
    );

    await FacebookComment.findOneAndUpdate({ commentId }, { $set: { isHidden: !!hidden } });
    res.json({ success: true });
  } catch (err) {
    console.error("Facebook hideComment error:", err.response?.data || err.message);
    res.status(500).json({ success: false, message: err.response?.data?.error?.message || err.message });
  }
}

export async function deleteComment(req, res) {
  try {
    const { commentId } = req.params;
    const { integrationId } = req.body;

    const { MetaIntegration, FacebookComment } = getTenantModels(req.tenantDB);
    const integration = integrationId
      ? await MetaIntegration.findById(integrationId)
      : await MetaIntegration.findOne({ status: "active" });
    if (!integration) return res.status(400).json({ success: false, message: "No active Facebook Page connected" });

    await axios.delete(`${GRAPH}/${commentId}`, {
      params: { access_token: integration.pageAccessToken },
    });

    await FacebookComment.findOneAndUpdate({ commentId }, { $set: { isDeleted: true } });
    res.json({ success: true });
  } catch (err) {
    console.error("Facebook deleteComment error:", err.response?.data || err.message);
    res.status(500).json({ success: false, message: err.response?.data?.error?.message || err.message });
  }
}

// ── Leads ─────────────────────────────────────────────────────────────────────

export async function getLeads(req, res) {
  try {
    const { page = 1, limit = 30, search = "" } = req.query;
    const { Lead } = getTenantModels(req.tenantDB);

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const baseQuery = { source: { $in: ["Facebook Ads", "Instagram Ads", "Facebook", "Instagram"] } };

    if (search.trim()) {
      baseQuery.$or = [
        { leadName: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { phoneNumber: { $regex: search, $options: "i" } },
      ];
    }

    const [leads, total] = await Promise.all([
      Lead.find(baseQuery).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean(),
      Lead.countDocuments(baseQuery),
    ]);

    res.json({ success: true, leads, total });
  } catch (err) {
    console.error("Facebook getLeads error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

// ── Webhook processor (called from meta.controller.js) ────────────────────────

export async function processFbCommentEvent(pageId, value) {
  try {
    const result = await findTenantByPageId(pageId);
    if (!result) return;
    const { conn } = result;
    const { FacebookComment } = getTenantModels(conn);

    const commentId = value.comment_id;
    if (!commentId) return;

    await FacebookComment.findOneAndUpdate(
      { commentId },
      {
        $setOnInsert: {
          pageId,
          postId: value.post_id || "",
          postMessage: "",
          postMediaUrl: "",
          commentId,
          parentCommentId: null,
        },
        $set: {
          senderName: value.from?.name || "Unknown User",
          senderFbId: value.sender_id || value.from?.id || "",
          text: value.message || "",
          fbTimestamp: value.created_time ? new Date(value.created_time * 1000) : new Date(),
        },
      },
      { upsert: true, new: false }
    );

    await emitToTenant(conn, "facebook:comment", {
      commentId,
      postId: value.post_id,
      text: value.message,
      senderName: value.from?.name || "Unknown User",
      pageId,
    });
  } catch (err) {
    console.error("Facebook processFbCommentEvent error:", err.message);
  }
}

export async function processFbMessengerEvent(pageId, messaging) {
  if (messaging.message?.is_echo) return;
  if (messaging.read || messaging.delivery) return;
  if (messaging.postback) return;

  try {
    const result = await findTenantByPageId(pageId);
    if (!result) return;

    const { conn, integration } = result;
    const { FacebookMessage } = getTenantModels(conn);

    const senderPsid = messaging.sender?.id;
    if (!senderPsid || senderPsid === pageId) return;

    const msgId = messaging.message?.mid;
    if (msgId) {
      const exists = await FacebookMessage.findOne({ messageId: msgId });
      if (exists) return;
    }

    let type = "text";
    let body = "";
    let mediaUrl = null;

    const msg = messaging.message || {};
    if (msg.text) {
      body = msg.text;
    } else if (msg.attachments?.length) {
      const att = msg.attachments[0];
      if (att.type === "image") { type = "image"; mediaUrl = att.payload?.url; body = "[Image]"; }
      else if (att.type === "video") { type = "video"; mediaUrl = att.payload?.url; body = "[Video]"; }
      else if (att.type === "audio") { type = "audio"; mediaUrl = att.payload?.url; body = "[Audio]"; }
      else if (att.type === "file") { type = "file"; mediaUrl = att.payload?.url; body = "[File]"; }
      else { type = "unsupported"; body = `[${att.type}]`; }
    }

    let senderName = "";
    let senderProfilePic = "";
    try {
      const { data: profile } = await axios.get(`${GRAPH}/${senderPsid}`, {
        params: { access_token: integration.pageAccessToken, fields: "name,profile_pic" },
      });
      senderName = profile.name || "";
      senderProfilePic = profile.profile_pic || "";
    } catch (_) { }

    const saved = await FacebookMessage.create({
      pageId,
      messageId: msgId,
      senderPsid,
      senderName,
      senderProfilePic,
      direction: "inbound",
      type,
      body,
      mediaUrl,
      status: "delivered",
      read: false,
      fbTimestamp: messaging.timestamp ? new Date(messaging.timestamp) : new Date(),
    });

    await emitToTenant(conn, "facebook:message", {
      message: saved,
      senderPsid,
      senderName,
      pageId,
      integrationId: integration._id,
    });
  } catch (err) {
    console.error("Facebook processFbMessengerEvent error:", err.message);
  }
}
