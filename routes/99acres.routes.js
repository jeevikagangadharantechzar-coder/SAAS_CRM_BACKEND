import express from "express";
import ninetyNineAcresController from "../controllers/99acres.controller.js";
import checkPlanFeature from "../middlewares/checkPlanFeature.js";

const router = express.Router();

router.use(checkPlanFeature("integration_99acres"));

// Route to receive 99acres leads (supports both GET and POST)
router.get("/webhook", ninetyNineAcresController.receiveWebhook);
router.post("/webhook", ninetyNineAcresController.receiveWebhook);

export default router;
