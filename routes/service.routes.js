import express from "express";
import { protect, requirePermission, adminOnly } from "../middlewares/auth.middleware.js";
import checkPlanFeature from "../middlewares/checkPlanFeature.js";
import {
  getServices,
  getServiceById,
  createService,
  updateService,
  deleteService,
} from "../controllers/service.controller.js";

const router = express.Router();

router.use(protect);
router.use(checkPlanFeature("products_services"));

// List and view services
router.get("/", requirePermission("products_services"), getServices);
router.get("/:id", requirePermission("products_services"), getServiceById);

// Manage services (Admin only)
router.post("/", adminOnly, createService);
router.put("/:id", adminOnly, updateService);
router.delete("/:id", adminOnly, deleteService);

export default router;
