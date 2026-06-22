import express from "express";

import { protect } from "../middlewares/auth.middleware.js";
import indexControllers from "../controllers/index.controllers.js";

const router = express.Router();

// POST /api/deals/lost-reason - Save loss reason for a deal
router.post("/lost-reason", protect, indexControllers.lostDealController.saveLostDealReason);

// GET /api/deals/lost-reasons - Get all loss reasons
router.get("/lost-reasons", protect, indexControllers.lostDealController.getLostDealReasons);

// GET /api/deals/analytics/lost - Get lost deal analytics
router.get("/analytics/lost", protect, indexControllers.lostDealAnalyticsController.getLostDealAnalytics);

// GET /api/deals/analytics/lost/export - Export lost deal report
router.get("/analytics/lost/export", protect, indexControllers.lostDealAnalyticsController.exportLostDealReport);

export default router;