import express from "express";
import { protect, adminOrSales, adminCreateOnly } from "../middlewares/auth.middleware.js";
import locationController from "../controllers/location.controller.js";

const router = express.Router();

router.post("/update", protect, adminOrSales, locationController.updateLocation);
router.get("/team", protect, adminCreateOnly, locationController.getTeamLocations);

export default router;
