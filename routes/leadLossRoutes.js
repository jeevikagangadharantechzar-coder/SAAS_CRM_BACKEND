import express from "express";
import leadLossController from "../controllers/leadLossAnalytics.controller.js";
import { protect } from "../middlewares/auth.middleware.js";

const router = express.Router();

router.get("/analytics", protect, leadLossController.getLeadLossAnalytics);

export default router;
