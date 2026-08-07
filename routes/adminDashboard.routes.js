import express from "express";
import indexControllers from "../controllers/index.controllers.js";
import { protect } from "../middlewares/auth.middleware.js";
import checkPlanFeature from "../middlewares/checkPlanFeature.js";

const router = express.Router();

// protect middleware to ensure req.user is available
//get the summary dashboard
router.get("/summary",    protect, indexControllers.adminDashboardController.getDashboardSummary);
router.get("/pipeline",   protect, indexControllers.adminDashboardController.getPipeline);
router.get("/streak-card", protect, indexControllers.adminDashboardController.getStreakCard);

// Combines leads + deals + invoices + summary (the 4 calls the admin
// dashboard fires on every load) into a single response. Gated by all three
// plan features since it returns all three data types in one shot.
router.get(
  "/overview",
  protect,
  checkPlanFeature("leads"),
  checkPlanFeature(["deals_all", "deals_pipeline"]),
  checkPlanFeature("invoices"),
  indexControllers.dashboardOverviewController.getDashboardOverview
);

export default router;