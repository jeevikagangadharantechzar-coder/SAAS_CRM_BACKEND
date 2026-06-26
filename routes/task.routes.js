import express from "express";
import { protect } from "../middlewares/auth.middleware.js";
import taskController from "../controllers/task.controller.js";

const router = express.Router();

router.get("/", protect, taskController.getTasks);
router.post("/", protect, taskController.createTask);
router.put("/:id", protect, taskController.updateTask);
router.patch("/:id/approve", protect, taskController.approveTask);
router.delete("/:id", protect, taskController.deleteTask);

export default router;
