import express from "express";
import leadLossController from "../controllers/leadLossAnalytics.controller.js";
import { protect, requirePermission } from "../middlewares/auth.middleware.js";

const router = express.Router();

router.get("/analytics", protect, requirePermission("loss_analysis"), leadLossController.getLeadLossAnalytics);

export default router;
