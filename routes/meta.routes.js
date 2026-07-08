/**
 * meta.routes.js
 * Tenant-scoped routes (require auth + resolveTenant)
 * Mounted at: /:tenantSlug/api/meta
 */

import express from "express";
import { protect } from "../middlewares/auth.middleware.js";
import metaController from "../controllers/meta.controller.js";
import checkPlanFeature from "../middlewares/checkPlanFeature.js";

const router = express.Router();

// All routes below require the user to be logged in
router.use(protect);
router.use(checkPlanFeature("integration_facebook"));

// GET  /meta/auth-url        → returns Facebook OAuth URL
router.get("/auth-url", metaController.getAuthUrl);

// POST /meta/callback        → exchange code, save page integration
router.post("/callback", metaController.handleCallback);

// GET  /meta/integrations    → list connected pages
router.get("/integrations", metaController.getIntegrations);

// DELETE /meta/integrations/:pageId → disconnect a page
router.delete("/integrations/:pageId", metaController.disconnectPage);

// POST /meta/sync → manually pull all leads from Facebook Graph API
router.post("/sync", metaController.syncLeads);

// POST /meta/test-lead → simulate a Facebook lead (DEVELOPMENT ONLY)
if (process.env.NODE_ENV !== "production") {
  router.post("/test-lead", metaController.simulateTestLead);
}

export default router;
