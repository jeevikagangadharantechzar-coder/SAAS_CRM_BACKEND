import express from "express";
import { protect, requirePermission } from "../middlewares/auth.middleware.js";
import targetController from "../controllers/target.controller.js";
import upload from "../middlewares/upload.js";

const router = express.Router();

// Serves both the admin "Target Management" full list and the sales-scoped
// "My Targets" view through the same endpoints (controllers already scope
// the query by role) — either permission is enough to reach the routes at all.
router.use(protect, requirePermission("target_management", "my_targets"));

router.get("/my", targetController.getMyTargets);
router.get("/dashboard-stats", targetController.getDashboardStats);
router.get("/my-dashboard-stats", targetController.getMyDashboardStats);
router.get("/my-progress-fallback", targetController.getMyProgressFallback);
router.get("/progress-fallback-all", targetController.getProgressFallbackAll);
router.get("/sales-summary/:userId", targetController.getSalesPersonSummary);
router.get("/admin-activity", targetController.getAdminActivity);
router.post("/admin-activity/dismiss", targetController.dismissAdminActivity);
router.get("/", targetController.getTargets);
router.post("/", targetController.createTarget);
router.put("/:id", targetController.updateTarget);
router.patch("/:id/rejection", targetController.approveRejection);
router.patch("/:id/hold", targetController.approveHold);
router.post("/:id/unlink-item", targetController.unlinkItem);
router.delete("/:id", targetController.deleteTarget);
router.post("/:id/notes", targetController.addNote);
router.post("/:id/reports/call", upload.single("recording"), targetController.addCallReport);
router.post("/:id/reports/meeting", upload.single("screenshot"), targetController.addMeetingReport);
router.post("/:id/reason-note", targetController.addReasonNote);
router.get("/reason-notes/all", targetController.getAllReasonNotes);
router.post("/reason-notes/bulk-delete", targetController.bulkDeleteReasonNotes);
router.post("/:id/reason-notes/:noteIdx/read", targetController.markReasonNoteRead);
router.post("/:id/reason-notes/:noteIdx/reassign", targetController.reassignItem);
router.post("/:id/reason-notes/:noteIdx/reply", targetController.replyReasonNote);
router.post("/:id/reason-notes/:noteIdx/reject", targetController.rejectReasonNote);
router.post("/:id/reassign", targetController.reassignTargetItems);
router.delete("/:id/reason-notes/:noteIdx", targetController.deleteReasonNote);
router.get("/linked/:itemType/:itemId", targetController.getLinkedTargets);

export default router;
