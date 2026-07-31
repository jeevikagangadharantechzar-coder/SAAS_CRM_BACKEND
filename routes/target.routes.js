import express from "express";
import { protect } from "../middlewares/auth.middleware.js";
import targetController from "../controllers/target.controller.js";
import upload from "../middlewares/upload.js";

const router = express.Router();

router.get("/my", protect, targetController.getMyTargets);
router.get("/dashboard-stats", protect, targetController.getDashboardStats);
router.get("/my-dashboard-stats", protect, targetController.getMyDashboardStats);
router.get("/my-progress-fallback", protect, targetController.getMyProgressFallback);
router.get("/progress-fallback-all", protect, targetController.getProgressFallbackAll);
router.get("/sales-summary/:userId", protect, targetController.getSalesPersonSummary);
router.get("/admin-activity", protect, targetController.getAdminActivity);
router.post("/admin-activity/dismiss", protect, targetController.dismissAdminActivity);
router.get("/", protect, targetController.getTargets);
router.post("/", protect, targetController.createTarget);
router.put("/:id", protect, targetController.updateTarget);
router.patch("/:id/rejection", protect, targetController.approveRejection);
router.patch("/:id/hold", protect, targetController.approveHold);
router.post("/:id/unlink-item", protect, targetController.unlinkItem);
router.delete("/:id", protect, targetController.deleteTarget);
router.post("/:id/notes", protect, targetController.addNote);
router.post("/:id/reports/call", protect, upload.single("recording"), targetController.addCallReport);
router.post("/:id/reports/meeting", protect, upload.single("screenshot"), targetController.addMeetingReport);
router.post("/:id/reason-note", protect, targetController.addReasonNote);
router.get("/reason-notes/all", protect, targetController.getAllReasonNotes);
router.post("/reason-notes/bulk-delete", protect, targetController.bulkDeleteReasonNotes);
router.post("/:id/reason-notes/:noteIdx/read", protect, targetController.markReasonNoteRead);
router.post("/:id/reason-notes/:noteIdx/reassign", protect, targetController.reassignItem);
router.post("/:id/reassign", protect, targetController.reassignTargetItems);
router.delete("/:id/reason-notes/:noteIdx", protect, targetController.deleteReasonNote);
router.get("/linked/:itemType/:itemId", protect, targetController.getLinkedTargets);

export default router;
