import express from "express";
import aiController from "../controllers/ai.controller.js";
import { protect } from "../middlewares/auth.middleware.js";
const router = express.Router();

// POST /api/ai/process
router.post("/chat", protect, aiController.processMessage);
router.get("/chat",  protect, aiController.processMessage);
router.get("/history", protect, aiController.getChatHistory);

export default router;