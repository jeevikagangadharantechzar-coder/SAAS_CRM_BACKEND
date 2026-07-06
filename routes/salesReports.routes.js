import express from "express";
import { protect, adminOrSales } from "../middlewares/auth.middleware.js";
import indexControllers from "../controllers/index.controllers.js";
import checkPlanFeature from "../middlewares/checkPlanFeature.js";

const router = express.Router();

router.use(checkPlanFeature("reports"));

// Fetch sales performance metrics
router.get("/performance", protect, adminOrSales, indexControllers.salesReportsController.getSalesPerformance);

export default router;
