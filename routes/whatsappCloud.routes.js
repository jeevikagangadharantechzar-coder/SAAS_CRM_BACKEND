import express from "express";
import { protect } from "../middlewares/auth.middleware.js";
import { uploadWhatsApp } from "../middlewares/uploadWhatsApp.js";
import {
  connectEmbeddedSignup,
  connectManual,
  getAuthUrl,
  handleCallback,
  confirmPhoneNumber,
  getIntegrations,
  disconnect,
  refreshToken,
  sendMessage,
  sendMedia,
  sendTemplateMessage,
  getConversations,
  getMessages,
  markAsRead,
  downloadMedia,
  getTemplates,
} from "../controllers/whatsappCloud.controller.js";

const router = express.Router();

// All routes require authentication
router.use(protect);

// ── Connect / manage integrations ───────────────────────────────────────────
router.post("/embedded-signup",    connectEmbeddedSignup); // POST /whatsapp/embedded-signup (FB.login popup flow)
router.post("/connect",            connectManual);         // POST /whatsapp/connect  (manual credential entry)
router.get("/auth-url",            getAuthUrl);           // GET  /whatsapp/auth-url  (OAuth flow — kept for reference)
router.post("/callback",           handleCallback);        // POST /whatsapp/callback
router.post("/confirm",            confirmPhoneNumber);    // POST /whatsapp/confirm
router.get("/integrations",        getIntegrations);       // GET  /whatsapp/integrations
router.delete("/integrations/:id", disconnect);            // DELETE /whatsapp/integrations/:id
router.post("/integrations/:id/refresh-token", refreshToken); // POST /whatsapp/integrations/:id/refresh-token

// ── Messaging ────────────────────────────────────────────────────────────────
router.post("/send",          sendMessage);                // POST /whatsapp/send
router.post("/send-media",    (req, res, next) => {
  uploadWhatsApp.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message });
    next();
  });
}, sendMedia);                                            // POST /whatsapp/send-media
router.post("/send-template", sendTemplateMessage);        // POST /whatsapp/send-template

// ── Conversations & Messages ─────────────────────────────────────────────────
router.get("/conversations",                  getConversations);  // GET /whatsapp/conversations
router.get("/messages/:contactWaId",          getMessages);       // GET /whatsapp/messages/:contactWaId
router.patch("/messages/:contactWaId/read",   markAsRead);        // PATCH /whatsapp/messages/:contactWaId/read

// ── Media proxy ──────────────────────────────────────────────────────────────
router.get("/media/:mediaId", downloadMedia); // GET /whatsapp/media/:mediaId

// ── Templates ────────────────────────────────────────────────────────────────
router.get("/templates", getTemplates); // GET /whatsapp/templates

export default router;
