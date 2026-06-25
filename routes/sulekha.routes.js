import express from "express";
import sulekhaController from "../controllers/sulekha.controller.js";

const router = express.Router();

// Route to receive Sulekha leads (supports both GET and POST)
router.get("/webhook", sulekhaController.receiveWebhook);
router.post("/webhook", sulekhaController.receiveWebhook);

export default router;
