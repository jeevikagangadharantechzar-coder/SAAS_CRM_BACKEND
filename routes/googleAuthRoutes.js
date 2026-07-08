import express from 'express';
import { protect } from "../middlewares/auth.middleware.js";
import googleAuthController from "../controllers/googleAuth.controller.js";
import checkPlanFeature from "../middlewares/checkPlanFeature.js";

const router = express.Router();

// Google OAuth routes
// The callback is intentionally left ungated — it's Google's own redirect
// target after consent, not a user-triggered entry point, and it carries no
// `protect` session either.
router.get('/auth/google', protect, checkPlanFeature("google_meet_sync"), googleAuthController.authenticate);
router.get('/auth/google/callback', googleAuthController.callback); // No protect middleware
router.get('/auth/status', protect, checkPlanFeature("google_meet_sync"), googleAuthController.getAuthStatus);
router.post('/auth/disconnect', protect, checkPlanFeature("google_meet_sync"), googleAuthController.disconnect);

export default router;


