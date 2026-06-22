import express from "express";
import indexControllers from "../controllers/index.controllers.js";
import { protect } from "../middlewares/auth.middleware.js";

const router = express.Router();

// protect middleware to ensure req.user is available
//get the summary dashboard
router.get("/summary",    protect, indexControllers.adminDashboardController.getDashboardSummary);
router.get("/pipeline",   protect, indexControllers.adminDashboardController.getPipeline);
router.get("/streak-card", protect, indexControllers.adminDashboardController.getStreakCard);

export default router;