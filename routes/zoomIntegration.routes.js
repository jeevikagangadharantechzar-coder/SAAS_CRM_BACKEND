import express from "express";
import { protect } from "../middlewares/auth.middleware.js";
import controller from "../controllers/zoomIntegration.controller.js";
import checkPlanFeature from "../middlewares/checkPlanFeature.js";

const router = express.Router();

router.use(checkPlanFeature("zoom_meetings"));

router.get("/", protect, controller.getStatus);
router.post("/", protect, controller.save);
router.delete("/", protect, controller.remove);

export default router;
