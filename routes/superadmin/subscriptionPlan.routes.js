import express from "express";
import { superAdminAuth, requireSuperAdminPermission } from "../../middlewares/superAdminAuth.js";
import {
  getAllPlans,
  getPlanById,
  createPlan,
  updatePlan,
  deletePlan,
  getPublicPlans,
  getLandingPagePlans,
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
router.get("/public/landing", getLandingPagePlans);

// Superadmin-protected routes
router.use(superAdminAuth, requireSuperAdminPermission("subscription_plans"));

router.get("/",                     getAllPlans);
router.get("/tenant-subscriptions", getTenantSubscriptions);
router.get("/:id",                  getPlanById);
router.post("/",                    validateCreatePlan, createPlan);
router.put("/:id",                  validateUpdatePlan, updatePlan);
router.delete("/:id",               deletePlan);
router.post("/assign-to-tenant",    assignPlanToTenant);

export default router;
