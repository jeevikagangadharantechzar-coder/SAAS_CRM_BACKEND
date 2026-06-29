import express from "express";
import { protect } from "../middlewares/auth.middleware.js";
import indiamartController from "../controllers/indiamart.controller.js";

const router = express.Router();

// Require authenticated user for all endpoints
router.use(protect);

router.get("/", indiamartController.getIntegrations);
router.get("/integrations", indiamartController.getIntegrations);
router.post("/connect", indiamartController.connect);
router.post("/disconnect", indiamartController.disconnect);
router.post("/sync", indiamartController.syncLeads);

export default router;
