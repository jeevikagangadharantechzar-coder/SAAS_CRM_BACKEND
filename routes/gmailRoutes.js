import express from "express";
import multer from "multer";
import {
  generateAuthUrl,
  exchangeCodeForTokens,
  listThreads,
  listAllThreads,
  getThread,
  checkAuth,
  sendEmailWithAttachments,
  deleteEmail,
  deleteThread,
  getAttachment,
  watchInbox,
  markAsRead,
  starThread,
  bulkStarThreads,
  markAsSpam,
  markAsImportant,
  moveToTrash,
  bulkMoveToTrash,
  bulkDeleteThreads,
  getLabels,
  applyLabel,
  saveDraft,
  getDrafts,
  getDraft,
  getEmailSuggestions,
  getLabelCounts,
  disconnectGmail,
  getAllActiveAccounts,
  deleteDraft,
} from "../utils/gmailService.js";

import {
  attachGmailSession,
  requireGmailAuth,
  setGmailSession,
  clearGmailSession,
  getEmailFromRequest,
} from "../middlewares/gmail.middleware.js";

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
  fileFilter: (_req, _file, cb) => cb(null, true),
});

// ─── Apply session reader to every Gmail route ────────────────────────────────
// attachGmailSession never blocks — it just reads the cookie
router.use(attachGmailSession);

// ═══════════════════════════════════════
// PUBLIC ROUTES  (no auth required)
// Mount these BEFORE requireGmailAuth
// ═══════════════════════════════════════
//test route
router.get("/test", (_req, res) =>
  res.json({
    success:   true,
    message:   "Gmail routes OK ",
    timestamp: new Date().toISOString(),
  })
);
//Get auth URL
router.get("/auth-url", (req, res) => {
  try {
    const host = req.get("host");
    const redirectUri =
      host?.includes("localhost") || host?.includes("127.0.0.1")
        ? process.env.GMAIL_REDIRECT_URI
        : process.env.GMAIL_LIVE_REDIRECT_URI;
    res.json({ success: true, url: generateAuthUrl(redirectUri) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
//Check auth status
router.get("/auth-status", async (req, res) => {
  try {
    // If there's already a valid session, return that — no need to hit DB twice
    if (req.gmailEmail) {
      return res.json({
        authenticated: true,
        message:       "Gmail is connected",
        email:         req.gmailEmail,
      });
    }
    // Fallback: legacy check (no active session)
    const status = await checkAuth(null);
    res.json({ ...status, authenticated: false });
  } catch {
    res.status(500).json({ authenticated: false, message: "Error checking auth" });
  }
});

/**
 * OAuth callback — the ONLY place where an email gets bound to a session.
 * After exchangeCodeForTokens() we call setGmailSession() which writes a
 * signed httpOnly cookie.  From this point on, all API calls are keyed to
 * that cookie — the client never needs to send an email parameter.
 */
router.get("/oauth2callback", async (req, res) => {
  const { code, error } = req.query;
  const host = req.get("host");
  const isLocal = host?.includes("localhost") || host?.includes("127.0.0.1");
  const frontendUrl = isLocal
    ? process.env.FRONTEND_URL_LOCAL
    : process.env.FRONTEND_URL;
  const redirectUri = isLocal
    ? process.env.GMAIL_REDIRECT_URI
    : process.env.GMAIL_LIVE_REDIRECT_URI;

  if (error) {
    const msg =
      error === "access_denied" ? "App not verified." : "Authorization failed.";
    return res.redirect(
      `${frontendUrl}/emailchat?gmail_error=1&error=${encodeURIComponent(msg)}`
    );
  }
  if (!code)
    return res.redirect(
      `${frontendUrl}/emailchat?gmail_error=1&error=No+authorization+code`
    );

  try {
    const result = await exchangeCodeForTokens(code, redirectUri);
    const email  = result.email;

    // bind the authenticated email to a server-side session
    setGmailSession(res, email);

    // Email is passed in the URL only so the frontend can display a
    // welcome message — it is NOT trusted for auth decisions.
    return res.redirect(
      `${frontendUrl}/emailchat?gmail_connected=1&email=${encodeURIComponent(email)}`
    );
  } catch (err) {
    let msg = err.message;
    if (err.message?.includes("invalid_grant"))
      msg = "Authorization code expired. Please reconnect.";
    return res.redirect(
      `${frontendUrl}/emailchat?gmail_error=1&error=${encodeURIComponent(msg)}`
    );
  }
});

// ═══════════════════════════════════════
// PROTECTED ROUTES WALL
// Everything below requires a valid session
// ═══════════════════════════════════════
router.use(requireGmailAuth);

// ═══════════════════════════════════════
// ACCOUNTS
// ═══════════════════════════════════════
router.get("/accounts", async (req, res) => {
  try {
    // Only return the account that belongs to this session
    const email = getEmailFromRequest(req);
    res.json({ success: true, accounts: [{ email }], current: { email } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════
// COUNTS
// ═══════════════════════════════════════
router.get("/all-counts", async (req, res) => {
  try {
    const email = getEmailFromRequest(req);
    const counts = await getLabelCounts(email);
    res.json({ success: true, counts });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════
// THREADS
// ═══════════════════════════════════════
router.get("/threads", async (req, res) => {
  try {
    const email      = getEmailFromRequest(req);
    const maxResults = parseInt(req.query.maxResults) || 20;
    const pageToken  = req.query.pageToken || null;
    const label      = req.query.label || "INBOX";
    const result     = await listThreads(maxResults, pageToken, label, email);
    res.set("Cache-Control", "private, max-age=30");
    res.json({
      success:         true,
      data:            result.threads,
      nextPageToken:   result.nextPageToken,
      totalEstimate:   result.resultSizeEstimate,
      label,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
//get all threads
router.get("/all-threads", async (req, res) => {
  try {
    const email   = getEmailFromRequest(req);
    const threads = await listAllThreads(email);
    res.json({ success: true, data: threads });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
//get single thread
router.get("/thread/:id", async (req, res) => {
  try {
    const email  = getEmailFromRequest(req);
    const thread = await getThread(req.params.id, email);
    res.json({ success: true, data: thread });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
//delete thread
router.delete("/thread/:id", async (req, res) => {
  try {
    const email = getEmailFromRequest(req);
    await deleteThread(req.params.id, email);
    res.json({ success: true, message: "Thread deleted" });
  } catch (err) {
    if (err.message?.includes("insufficientPermissions"))
      return res.status(403).json({
        success: false,
        error:   "Insufficient permissions. Please reconnect Gmail.",
      });
    res.status(500).json({ success: false, error: err.message });
  }
});
//mark read/unread
router.post("/thread/:id/read", async (req, res) => {
  try {
    const email = getEmailFromRequest(req);
    await markAsRead(req.params.id, req.body.read !== false, email);
    res.json({
      success: true,
      message: `Marked as ${req.body.read !== false ? "read" : "unread"}`,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
//star/unstar thread
router.post("/thread/:id/star", async (req, res) => {
  try {
    const email = getEmailFromRequest(req);
    await starThread(req.params.id, req.body.star !== false, email);
    res.json({
      success: true,
      message: `Thread ${req.body.star !== false ? "starred" : "unstarred"}`,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
//mark spam
router.post("/thread/:id/spam", async (req, res) => {
  try {
    const email = getEmailFromRequest(req);
    await markAsSpam(req.params.id, req.body.spam !== false, email);
    res.json({ success: true, message: "Spam status updated" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
//most important
router.post("/thread/:id/important", async (req, res) => {
  try {
    const email = getEmailFromRequest(req);
    await markAsImportant(req.params.id, req.body.important !== false, email);
    res.json({ success: true, message: "Important status updated" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
//move to trash
router.post("/thread/:id/trash", async (req, res) => {
  try {
    const email = getEmailFromRequest(req);
    await moveToTrash(req.params.id, email);
    res.json({ success: true, message: "Thread moved to trash" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
//apply lable
router.post("/thread/:id/label", async (req, res) => {
  try {
    const email = getEmailFromRequest(req);
    await applyLabel(req.params.id, req.body.labelId, email);
    res.json({ success: true, message: "Label applied" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════
// BULK
// ═══════════════════════════════════════
//bulk delete
router.post("/bulk-delete", async (req, res) => {
  try {
    const email               = getEmailFromRequest(req);
    const { threadIds, permanent = false } = req.body;
    if (!threadIds?.length)
      return res.status(400).json({ success: false, error: "No thread IDs" });
    const result = permanent
      ? await bulkDeleteThreads(threadIds, email)
      : await bulkMoveToTrash(threadIds, email);
    res.json({ success: true, message: result.message, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
//bulk star the messages
router.post("/bulk-star", async (req, res) => {
  try {
    const email              = getEmailFromRequest(req);
    const { threadIds, star } = req.body;
    if (!threadIds?.length)
      return res.status(400).json({ success: false, error: "No thread IDs" });
    const result = await bulkStarThreads(threadIds, star !== false, email);
    res.json({ success: true, message: result.message, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
//bulk trash the messages
router.post("/bulk-trash", async (req, res) => {
  try {
    const email            = getEmailFromRequest(req);
    const { threadIds }    = req.body;
    if (!threadIds?.length)
      return res.status(400).json({ success: false, error: "No thread IDs" });
    const result = await bulkMoveToTrash(threadIds, email);
    res.json({ success: true, message: result.message, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════
// SEND
// ═══════════════════════════════════════
//send email
router.post("/send", upload.array("attachments", 10), async (req, res) => {
  try {
    const email = getEmailFromRequest(req);
    const { to, cc, bcc, subject, message } = req.body;
    if (!to)
      return res.status(400).json({ success: false, error: "Recipient required" });

    const attachments = [];
    for (const file of req.files || []) {
      if (file.size > 25 * 1024 * 1024)
        return res
          .status(400)
          .json({ success: false, error: `"${file.originalname}" exceeds 25MB` });
      attachments.push({
        filename: file.originalname,
        content:  file.buffer.toString("base64"),
        mimetype: file.mimetype,
        size:     file.size,
      });
    }

    const result = await sendEmailWithAttachments(
      to, subject || "(No Subject)", message || "",
      cc || "", bcc || "", attachments, [], email
    );
    res.json({
      success:  true,
      data:     { id: result.id, threadId: result.threadId },
      message:  "Email sent!",
      sendTime: result.sendTime,
    });
  } catch (err) {
    let statusCode = 500;
    if (err.message?.includes("Invalid recipient") || err.message?.includes("25MB"))
      statusCode = 400;
    else if (err.message?.includes("auth"))
      statusCode = 401;
    res.status(statusCode).json({ success: false, error: err.message });
  }
});
//delete message
router.delete("/message/:id", async (req, res) => {
  try {
    const email = getEmailFromRequest(req);
    await deleteEmail(req.params.id, email);
    res.json({ success: true, message: "Email deleted" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════
// DRAFTS
// ═══════════════════════════════════════
//save draft
router.post("/draft", upload.array("attachments", 10), async (req, res) => {
  try {
    const email = getEmailFromRequest(req);
    const { to, cc, bcc, subject, message } = req.body;
    if (!to)
      return res.status(400).json({ success: false, error: "Recipient required" });
    const attachments = (req.files || []).map((f) => ({
      filename: f.originalname,
      content:  f.buffer.toString("base64"),
      mimetype: f.mimetype,
      size:     f.size,
    }));
    const result = await saveDraft(
      to, subject || "(No Subject)", message || "",
      cc || "", bcc || "", attachments, [], email
    );
    res.json({ success: true, data: result, message: "Draft saved" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
//list drafts
router.get("/drafts", async (req, res) => {
  try {
    const email  = getEmailFromRequest(req);
    const drafts = await getDrafts(parseInt(req.query.maxResults) || 20, email);
    res.json({ success: true, data: drafts, totalCount: drafts.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
//draft counts
router.get("/drafts/count", async (req, res) => {
  try {
    const email  = getEmailFromRequest(req);
    const drafts = await getDrafts(100, email);
    res.json({ success: true, count: drafts.length });
  } catch {
    res.json({ success: true, count: 0 });
  }
});
//get draft
router.get("/draft/:draftId", async (req, res) => {
  try {
    const email = getEmailFromRequest(req);
    const draft = await getDraft(req.params.draftId, email);
    res.json({ success: true, data: draft });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
//delete draft
router.delete("/draft/:id", async (req, res) => {
  try {
    const email = getEmailFromRequest(req);
    await deleteDraft(req.params.id, email);
    res.json({ success: true, message: "Draft deleted" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════
// ATTACHMENTS
// ═══════════════════════════════════════
router.get("/attachment/:messageId/:attachmentId", async (req, res) => {
  try {
    const email      = getEmailFromRequest(req);
    const attachment = await getAttachment(
      req.params.messageId, req.params.attachmentId, email
    );
    res.json({ success: true, data: attachment });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════
// DISCONNECT
// ═══════════════════════════════════════
router.delete("/disconnect", async (req, res) => {
  try {
    const email = getEmailFromRequest(req);
    // Clear server-side session FIRST so no further requests go through
    clearGmailSession(req, res);
    const result = await disconnectGmail(email);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════
// LABELS & SUGGESTIONS
// ═══════════════════════════════════════
router.get("/labels", async (req, res) => {
  try {
    const email  = getEmailFromRequest(req);
    const labels = await getLabels(email);
    res.json({ success: true, data: labels });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/suggestions", async (req, res) => {
  try {
    const email       = getEmailFromRequest(req);
    const suggestions = await getEmailSuggestions(req.query.query || "", 10, email);
    res.json({ success: true, data: suggestions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════
router.post("/watch", async (req, res) => {
  try {
    const email  = getEmailFromRequest(req);
    const result = await watchInbox(email);
    res.json({ success: true, historyId: result.historyId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
//clear cache
router.delete("/clear-cache", (_req, res) =>
  res.json({ success: true, message: "Cache cleared" })
);

export default router;