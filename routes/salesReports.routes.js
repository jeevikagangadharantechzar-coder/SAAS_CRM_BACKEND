import express from "express";
import { protect, adminOrSales, requirePermission } from "../middlewares/auth.middleware.js";
import indexControllers from "../controllers/index.controllers.js";

const router = express.Router();

// Fetch sales performance metrics
router.get("/performance", protect, adminOrSales, requirePermission("reports"), indexControllers.salesReportsController.getSalesPerformance);

export default router;
