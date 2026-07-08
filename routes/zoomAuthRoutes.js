import express from 'express';
import { protect } from "../middlewares/auth.middleware.js";
import zoomAuthController from "../controllers/zoomAuth.controller.js";
import checkPlanFeature from "../middlewares/checkPlanFeature.js";

const router = express.Router();

// Zoom is configured as a single shared Server-to-Server account for the
// whole CRM — there is no per-user OAuth consent flow, just a status check
// the frontend uses to know whether the Zoom option is available.
router.get('/auth/status', protect, checkPlanFeature("zoom_meetings"), zoomAuthController.getAuthStatus);

export default router;
