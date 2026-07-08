import express from "express";
import { protect } from "../middlewares/auth.middleware.js";
import linkedinController from "../controllers/linkedin.controller.js";
import checkPlanFeature from "../middlewares/checkPlanFeature.js";

const router = express.Router();

// Require authenticated user for all configuration endpoints
router.use(protect);
router.use(checkPlanFeature("integration_linkedin"));

// GET  /linkedin/auth-url    → returns OAuth URL with state
router.get("/auth-url", linkedinController.getAuthUrl);

// GET  /linkedin/callback    → OAuth redirect callback (exchanges code & fetches pages/forms)
router.get("/callback", linkedinController.handleCallback);

// GET  /linkedin/forms       → fetches lead forms for selected ad account
router.get("/forms", linkedinController.fetchForms);

// POST /linkedin/connect     → finalizes integration and stores mappings
router.post("/connect", linkedinController.connect);

// GET  /linkedin/integrations → lists integrations for the tenant
router.get("/integrations", linkedinController.getIntegrations);

// POST /linkedin/disconnect  → disconnects the integration
router.post("/disconnect", linkedinController.disconnect);

// POST /linkedin/sync-leads   → manually sync leads
router.post("/sync-leads", linkedinController.syncLeads);

export default router;
