import express from "express";
import { protect } from "../middlewares/auth.middleware.js";
import clientLTVController from "../controllers/clientLTVController.js";

const router = express.Router();
router.use(protect);

// Dashboard
router.get("/dashboard", clientLTVController.getCLVDashboard);

// Won deals for client review
router.get("/won-deals", clientLTVController.getWonDeals);

// Client reviews
router.post("/client-review", clientLTVController.createClientReview);

// Client details
router.get("/client/:companyName", clientLTVController.getClientCLV);

// CLV calculations
router.post("/calculate-all", clientLTVController.calculateAllCLV);
router.post("/calculate/:companyName", clientLTVController.calculateClientCLV);

// Support tickets
router.post("/tickets", clientLTVController.createSupportTicket);

// Renewals
router.post("/renewals", clientLTVController.createRenewal);

// Pricing risks
router.get("/pricing-risks", clientLTVController.getPricingRisks);
router.patch("/pricing-risks/:id/resolve", clientLTVController.resolvePricingRisk);

// Pricing recommendation
router.get("/pricing-recommendation/:companyName", clientLTVController.getPricingRecommendation);


// Sync follow-up data with CLV
router.post("/sync-followup/:companyName", clientLTVController.syncFollowUpData);

// Refresh client metrics
router.post("/refresh-client-metrics/:companyName", clientLTVController.refreshClientMetrics);

export default router;