import express from "express";
import multer from "multer";
import indexControllers from "../controllers/index.controllers.js";
import { protect, requirePermission } from "../middlewares/auth.middleware.js";

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB limit
});

const router = express.Router();

// Mass/bulk campaign email — matches the "Email Campaigns" permission
// (distinct from "email_chat", the per-lead/deal Email tab gated separately).
router.use(protect, requirePermission("email_campaigns"));

// POST /api/email/send-bulk
router.post(
  "/send-bulk",
  upload.array("attachments"),indexControllers.massEmailController.
  sendBulkEmail
);

// GET /api/email/history
router.get("/history", indexControllers.massEmailController.getEmailHistory);

// GET /api/email/scheduled
router.get("/scheduled", indexControllers.massEmailController.getScheduledEmails);

// IMPORTANT FIX: Use upload.array with the correct field name
router.put(
  "/update/:id",
  upload.array("newAttachments"), // This was the issue - missing 'upload.'
  indexControllers.massEmailController.updateScheduledEmail
);

// PATCH /api/email/cancel/:id — soft-cancel a scheduled email (status ->
// "cancelled"), keeping the record so it's still visible in things like a
// Deal's Activity Log, unlike DELETE /delete/:id below which removes it entirely.
router.patch("/cancel/:id", indexControllers.massEmailController.cancelScheduledEmail);

// DELETE /api/email/delete/:id
router.delete("/delete/:id", indexControllers.massEmailController.deleteEmail);

// NEW: POST /api/email/bulk-delete - Bulk email delete
router.post("/bulk-delete", indexControllers.massEmailController.bulkDeleteEmailHistory);

// GET /api/email/contacts — all leads + deals for mass email
router.get("/contacts", indexControllers.massEmailController.getAllEmailContacts);
// GET /api/email/:id
router.get("/:id", indexControllers.massEmailController.getSingleEmail);

export default router;