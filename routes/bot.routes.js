import express from "express";
import { protect } from "../middlewares/auth.middleware.js";
import indexControllers from "../controllers/index.controllers.js";
import checkPlanFeature from "../middlewares/checkPlanFeature.js";

const router = express.Router();
router.use(protect);
router.use(checkPlanFeature("chatbot"));

// single endpoint handles both: text command AND contactId picker choice
// POST process call command
router.post("/command",  indexControllers.botController.parseCallCommand);
router.get("/suggestions", indexControllers.botController.getSuggestions);
router.get("/history",   indexControllers.botController.getHistory);

export default router;