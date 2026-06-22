import express from "express";
import { superAdminAuth } from "../../middlewares/superAdminAuth.js";
import {
  getAllPlans,
  getPlanById,
  createPlan,
  updatePlan,
  deletePlan,
  getPublicPlans,
  assignPlanToTenant,
  getTenantSubscriptions,
} from "../../controllers/subscriptionPlan.controller.js";
import {
  validateCreatePlan,
  validateUpdatePlan,
} from "../../validators/subscriptionPlan.validator.js";

const router = express.Router();

// Public — no auth (for pricing pages)
router.get("/public", getPublicPlans);

// Superadmin-protected routes
router.get("/",                     superAdminAuth, getAllPlans);
router.get("/tenant-subscriptions", superAdminAuth, getTenantSubscriptions);
router.get("/:id",                  superAdminAuth, getPlanById);
router.post("/",                    superAdminAuth, validateCreatePlan, createPlan);
router.put("/:id",                  superAdminAuth, validateUpdatePlan, updatePlan);
router.delete("/:id",               superAdminAuth, deletePlan);
router.post("/assign-to-tenant",    superAdminAuth, assignPlanToTenant);

export default router;
