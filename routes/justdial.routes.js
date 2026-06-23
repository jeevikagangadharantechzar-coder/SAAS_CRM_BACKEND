import express from "express";
import justdialController from "../controllers/justdial.controller.js";

const router = express.Router();

// Route to receive Justdial leads (supports both GET and POST)
router.get("/webhook", justdialController.receiveWebhook);
router.post("/webhook", justdialController.receiveWebhook);

export default router;
