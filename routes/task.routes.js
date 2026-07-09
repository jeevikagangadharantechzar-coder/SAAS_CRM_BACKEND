import express from "express";
import { protect } from "../middlewares/auth.middleware.js";
import taskController from "../controllers/task.controller.js";

const router = express.Router();

router.get("/", protect, taskController.getTasks);
router.post("/", protect, taskController.createTask);
router.get("/progress/mine", protect, taskController.getMyTaskProgress);
router.get("/progress/all", protect, taskController.getTaskProgressAll);
router.get("/admin-activity", protect, taskController.getAdminActivity);
router.post("/admin-activity/dismiss", protect, taskController.dismissAdminActivity);
router.get("/reason-notes/all", protect, taskController.getAllReasonNotes);
router.post("/reason-notes/bulk-delete", protect, taskController.bulkDeleteReasonNotes);
router.put("/:id", protect, taskController.updateTask);
router.patch("/:id/approve", protect, taskController.approveTask);
router.patch("/:id/reassign", protect, taskController.reassignTask);
router.post("/:id/reason-note", protect, taskController.addReasonNote);
router.post("/:id/reason-notes/:noteIdx/reassign", protect, taskController.reassignReasonNote);
router.delete("/:id/reason-notes/:noteIdx", protect, taskController.deleteReasonNote);
router.delete("/:id", protect, taskController.deleteTask);

export default router;
