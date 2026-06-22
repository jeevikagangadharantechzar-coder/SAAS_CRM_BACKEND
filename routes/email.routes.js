import express from "express";
import multer from "multer";
import indexControllers from "../controllers/index.controllers.js";
import { protect } from "../middlewares/auth.middleware.js";

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB limit
});

const router = express.Router();

// POST /api/email/send-bulk
router.post(
  "/send-bulk",
  protect,
  upload.array("attachments"),indexControllers.massEmailController.
  sendBulkEmail
);

// GET /api/email/history
router.get("/history", protect, indexControllers.massEmailController.getEmailHistory);

// GET /api/email/scheduled
router.get("/scheduled", protect, indexControllers.massEmailController.getScheduledEmails);

// IMPORTANT FIX: Use upload.array with the correct field name
router.put(
  "/update/:id", 
  protect, 
  upload.array("newAttachments"), // This was the issue - missing 'upload.'
  indexControllers.massEmailController.updateScheduledEmail
);

// DELETE /api/email/delete/:id
router.delete("/delete/:id", protect, indexControllers.massEmailController.deleteEmail);

// NEW: POST /api/email/bulk-delete - Bulk email delete
router.post("/bulk-delete", protect, indexControllers.massEmailController.bulkDeleteEmailHistory);

// GET /api/email/contacts — all leads + deals for mass email
router.get("/contacts", protect, indexControllers.massEmailController.getAllEmailContacts);
// GET /api/email/:id
router.get("/:id", protect, indexControllers.massEmailController.getSingleEmail);

export default router;