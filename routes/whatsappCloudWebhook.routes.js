import express from "express";
import { verifyWebhook, receiveWebhook } from "../controllers/whatsappCloud.controller.js";

const router = express.Router();

// Public — Meta calls these directly, no auth middleware
router.get("/",  verifyWebhook);   // GET  /webhooks/whatsapp  — Meta verification
router.post("/", receiveWebhook);  // POST /webhooks/whatsapp  — incoming messages & status updates

export default router;
