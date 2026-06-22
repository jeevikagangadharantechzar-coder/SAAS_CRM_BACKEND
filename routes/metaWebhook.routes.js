/**
 * metaWebhook.routes.js
 * PUBLIC routes — no auth, no resolveTenant
 * Meta calls these directly from their servers
 * Mounted at: /webhooks/meta
 */

import express from "express";
import metaController from "../controllers/meta.controller.js";

const router = express.Router();

// GET  /webhooks/meta  → Meta webhook verification (one-time setup)
router.get("/", metaController.verifyWebhook);

// POST /webhooks/meta  → Meta sends real-time lead events here
router.post("/", metaController.receiveWebhook);

export default router;
