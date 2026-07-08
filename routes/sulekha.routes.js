import express from "express";
import sulekhaController from "../controllers/sulekha.controller.js";
import checkPlanFeature from "../middlewares/checkPlanFeature.js";

const router = express.Router();

router.use(checkPlanFeature("integration_sulekha"));

// Route to receive Sulekha leads (supports both GET and POST)
router.get("/webhook", sulekhaController.receiveWebhook);
router.post("/webhook", sulekhaController.receiveWebhook);

export default router;
