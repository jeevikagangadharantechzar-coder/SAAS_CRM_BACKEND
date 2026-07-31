import express from "express";
import { protect } from "../middlewares/auth.middleware.js";
import { uploadInstagram } from "../middlewares/uploadInstagram.js";
import {
  getAuthUrl,
  handleCallback,
  confirmAccount,
  getIntegrations,
  disconnect,
  refreshToken,
  getConversations,
  getMessages,
  markAsRead,
  sendMessage,
  sendMedia,
  getPostComments,
  replyToComment,
  hideComment,
  deleteComment,
  syncComments,
} from "../controllers/instagram.controller.js";

const router = express.Router();

router.use(protect);

// ── Connect / manage ──────────────────────────────────────────────────────────
router.get("/auth-url",             getAuthUrl);
router.post("/callback",            handleCallback);
router.post("/confirm",             confirmAccount);
router.get("/integrations",         getIntegrations);
router.delete("/integrations/:id",  disconnect);
router.post("/integrations/:id/refresh-token", refreshToken);

// ── DM conversations & messages ───────────────────────────────────────────────
router.get("/conversations",                    getConversations);
router.get("/messages/:senderIgsid",            getMessages);
router.patch("/messages/:senderIgsid/read",     markAsRead);

// ── Send DM ───────────────────────────────────────────────────────────────────
router.post("/send", sendMessage);
router.post("/send-media", (req, res, next) => {
  uploadInstagram.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message });
    next();
  });
}, sendMedia);

// ── Post comments ─────────────────────────────────────────────────────────────
router.get("/comments",               getPostComments);
router.get("/comments/sync",          syncComments);
router.post("/comments/:commentId/reply",  replyToComment);
router.post("/comments/:commentId/hide",   hideComment);
router.delete("/comments/:commentId",      deleteComment);

export default router;
