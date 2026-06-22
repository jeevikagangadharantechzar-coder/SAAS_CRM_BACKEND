import express from 'express';
import { protect } from "../middlewares/auth.middleware.js";
import googleAuthController from "../controllers/googleAuth.controller.js";

const router = express.Router();

// Google OAuth routes
router.get('/auth/google', protect, googleAuthController.authenticate);
router.get('/auth/google/callback', googleAuthController.callback); // No protect middleware
router.get('/auth/status', protect, googleAuthController.getAuthStatus);
router.post('/auth/disconnect', protect, googleAuthController.disconnect);

export default router;


