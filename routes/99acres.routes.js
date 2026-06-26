import express from "express";
import ninetyNineAcresController from "../controllers/99acres.controller.js";

const router = express.Router();

// Route to receive 99acres leads (supports both GET and POST)
router.get("/webhook", ninetyNineAcresController.receiveWebhook);
router.post("/webhook", ninetyNineAcresController.receiveWebhook);

export default router;
