import express from "express";
import { processLinkedInLeadWebhook } from "../controllers/linkedin.controller.js";

const router = express.Router();

// Public webhook receiver - no authentication required
router.post("/", processLinkedInLeadWebhook);

export default router;
