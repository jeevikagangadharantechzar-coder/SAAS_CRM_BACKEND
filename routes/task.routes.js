import express from "express";
import { protect, requirePermission } from "../middlewares/auth.middleware.js";
import taskController from "../controllers/task.controller.js";

const router = express.Router();

// Serves both the admin "Task Management" full list and the sales-scoped
// "My Tasks" view through the same endpoints (controllers already scope the
// query by role) — either permission is enough to reach the routes at all.
router.use(protect, requirePermission("task_management", "assigned_tasks"));

router.get("/", taskController.getTasks);
router.post("/", taskController.createTask);
router.get("/progress/mine", taskController.getMyTaskProgress);
router.get("/progress/all", taskController.getTaskProgressAll);
router.get("/reassignment-check/:itemType/:itemId/:oldUserId", taskController.checkReassignment);
router.get("/admin-activity", taskController.getAdminActivity);
router.post("/admin-activity/dismiss", taskController.dismissAdminActivity);
router.get("/reason-notes/all", taskController.getAllReasonNotes);
router.post("/reason-notes/bulk-delete", taskController.bulkDeleteReasonNotes);
router.put("/:id", taskController.updateTask);
router.patch("/:id/approve", taskController.approveTask);
router.patch("/:id/rejection", taskController.approveRejection);
router.patch("/:id/hold", taskController.approveHold);
router.patch("/:id/reassign", taskController.reassignTask);
router.post("/:id/reason-note", taskController.addReasonNote);
router.post("/:id/reason-notes/:noteIdx/read", taskController.markReasonNoteRead);
router.post("/:id/reason-notes/:noteIdx/reassign", taskController.reassignReasonNote);
router.post("/:id/reason-notes/:noteIdx/reply", taskController.replyReasonNote);
router.post("/:id/reason-notes/:noteIdx/reject", taskController.rejectReasonNote);
router.delete("/:id/reason-notes/:noteIdx", taskController.deleteReasonNote);
router.delete("/:id", taskController.deleteTask);
router.get("/linked/:itemType/:itemId", taskController.getLinkedTasks);

export default router;
