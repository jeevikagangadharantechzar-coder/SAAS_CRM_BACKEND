import express from "express";
import justdialController from "../controllers/justdial.controller.js";
import checkPlanFeature from "../middlewares/checkPlanFeature.js";

const router = express.Router();

router.use(checkPlanFeature("integration_justdial"));

// Route to receive Justdial leads (supports both GET and POST)
router.get("/webhook", justdialController.receiveWebhook);
router.post("/webhook", justdialController.receiveWebhook);

export default router;
