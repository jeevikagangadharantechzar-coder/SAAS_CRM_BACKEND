import express from "express";
import { verifyWebhook, receiveWebhook } from "../controllers/instagram.controller.js";

const router = express.Router();

// Public — Meta calls these directly, no auth
router.get("/",  verifyWebhook);   // GET  /webhooks/instagram
router.post("/", receiveWebhook);  // POST /webhooks/instagram

export default router;
