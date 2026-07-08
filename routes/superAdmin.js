import express from "express";
import { superAdminAuth } from "../middlewares/superAdminAuth.js";
import { login } from "../controllers/superAdmin.controller.js";
import {
  createTenant,
  listTenants,
  toggleTenant,
  deleteTenant,
  getDashboardStats,
  impersonateTenant,
  createUpgradeRequest,
  getUpgradeRequests,
  approveUpgradeRequest,
  rejectUpgradeRequest,
  getTenantDetails,
  getTenantBySlugPublic,
  getUpgradeHistory,
  updateTenant,
} from "../controllers/tenant.controller.js";
import { listFreeTrialSignups, deleteFreeTrialSignup } from "../controllers/freeTrial.controller.js";
import { runFreeTrialCron } from "../cron/freeTrialCron.js";

const router = express.Router();

// Auth
router.post("/api/auth/login", login);

// Tenant management — all protected except submit upgrade-request which can be called by tenant portal
router.post("/api/tenants/upgrade-request", createUpgradeRequest);
router.get("/api/tenants/public/by-slug/:slug", getTenantBySlugPublic);

// Upgrade request management for Superadmin
router.get("/api/tenants/upgrade-requests", superAdminAuth, getUpgradeRequests);
router.get("/api/tenants/upgrade-history", superAdminAuth, getUpgradeHistory);
router.post("/api/tenants/upgrade-approve/:id", superAdminAuth, approveUpgradeRequest);
router.post("/api/tenants/upgrade-reject/:id", superAdminAuth, rejectUpgradeRequest);

router.post("/api/tenants/create",        superAdminAuth, createTenant);
router.get("/api/tenants",                superAdminAuth, listTenants);
router.get("/api/tenants/:id",            superAdminAuth, getTenantDetails);
router.put("/api/tenants/:id",             superAdminAuth, updateTenant);
router.patch("/api/tenants/:id/toggle",   superAdminAuth, toggleTenant);
router.delete("/api/tenants/:id",         superAdminAuth, deleteTenant);
router.get("/api/dashboard/stats",        superAdminAuth, getDashboardStats);
router.post("/api/tenants/:id/impersonate", superAdminAuth, impersonateTenant);

// Free trial signup log
router.get("/api/free-trials",             superAdminAuth, listFreeTrialSignups);
router.delete("/api/free-trials/:id",      superAdminAuth, deleteFreeTrialSignup);

// Manually fires the free-trial reminder/expiry cron on demand — the
// scheduled job only runs hourly (cron/freeTrialCron.js), so this lets an
// admin verify a trial-date change immediately instead of waiting for the
// next tick.
router.post("/api/free-trials/run-cron", superAdminAuth, async (req, res) => {
  try {
    await runFreeTrialCron();
    res.json({ success: true, message: "Free-trial cron executed" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
