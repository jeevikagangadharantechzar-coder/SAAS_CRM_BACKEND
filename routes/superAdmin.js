import express from "express";
import { superAdminAuth, requireSuperAdminPermission } from "../middlewares/superAdminAuth.js";
import { login, verifyMfaLogin, getMe, getProfile, updateProfile, changeOwnPassword  } from "../controllers/superAdmin.controller.js";
import {
  generateSuperAdminMfa,
  verifyAndEnableSuperAdminMfa,
  disableSuperAdminMfa
} from "../controllers/mfa.controller.js";
import {
  createTenant,
  listTenants,
  toggleTenant,
  deleteTenant,
  getDashboardStats,
  getSuperAdminDashboardData,
  impersonateTenant,
  createUpgradeRequest,
  getUpgradeRequests,
  approveUpgradeRequest,
  rejectUpgradeRequest,
  getTenantDetails,
  getTenantBySlugPublic,
  getUpgradeHistory,
  deleteUpgradeHistoryItem,
  bulkDeleteUpgradeHistory,
  updateTenant,
} from "../controllers/tenant.controller.js";
import {
  getPublicBranding,
  getSettings as getSuperAdminSettings,
  updateSettings as updateSuperAdminSettings,
  uploadPlatformLogo,
  uploadSuperAdminFavicon,
} from "../controllers/superAdminSettings.controller.js";
import uploadPlatformLogoMiddleware from "../middlewares/uploadPlatformLogo.js";
import {
  listFreeTrialSignups,
  deleteFreeTrialSignup,
  getFreeTrialSignupDetails,
  getFreeTrialAnalysis
} from "../controllers/freeTrial.controller.js";
import { runFreeTrialCron } from "../cron/freeTrialCron.js";
import { getTenantActivityLogs } from "../controllers/tenantActivityLog.controller.js";

const router = express.Router();

// Auth
router.post("/api/auth/login", login);
router.post("/api/auth/login/verify-mfa", verifyMfaLogin);
router.get("/api/auth/me", superAdminAuth, getMe);

// MFA

router.post("/api/mfa/setup", superAdminAuth, generateSuperAdminMfa);
router.post("/api/mfa/enable", superAdminAuth, verifyAndEnableSuperAdminMfa);
router.post("/api/mfa/disable", superAdminAuth, disableSuperAdminMfa);

// Self-service profile — available to any authenticated super admin,
// regardless of role, since everyone must always be able to manage their own
// account. Distinct from /api/admin-users which manages OTHER accounts and
// requires the admin_users permission.
router.get("/api/profile", superAdminAuth, getProfile);
router.put("/api/profile", superAdminAuth, updateProfile);
router.put("/api/profile/password", superAdminAuth, changeOwnPassword);

// Tenant management — all protected except submit upgrade-request which can be called by tenant portal
router.post("/api/tenants/upgrade-request", createUpgradeRequest);
router.get("/api/tenants/public/by-slug/:slug", getTenantBySlugPublic);

// Upgrade request management for Superadmin
router.get("/api/tenants/upgrade-requests", superAdminAuth, requireSuperAdminPermission("upgrade_requests"), getUpgradeRequests);
router.get("/api/tenants/upgrade-history", superAdminAuth, requireSuperAdminPermission("upgrade_requests"), getUpgradeHistory);
router.post("/api/tenants/upgrade-history/bulk-delete", superAdminAuth, requireSuperAdminPermission("upgrade_requests"), bulkDeleteUpgradeHistory);
router.delete("/api/tenants/upgrade-history/:id", superAdminAuth, requireSuperAdminPermission("upgrade_requests"), deleteUpgradeHistoryItem);
router.post("/api/tenants/upgrade-approve/:id", superAdminAuth, requireSuperAdminPermission("upgrade_requests"), approveUpgradeRequest);
router.post("/api/tenants/upgrade-reject/:id", superAdminAuth, requireSuperAdminPermission("upgrade_requests"), rejectUpgradeRequest);

router.post("/api/tenants/create", superAdminAuth, requireSuperAdminPermission("tenants"), createTenant);
router.get("/api/tenants", superAdminAuth, requireSuperAdminPermission("tenants"), listTenants);
router.get("/api/tenants/:id", superAdminAuth, requireSuperAdminPermission("tenants"), getTenantDetails);
router.put("/api/tenants/:id", superAdminAuth, requireSuperAdminPermission("tenants"), updateTenant);
router.patch("/api/tenants/:id/toggle", superAdminAuth, requireSuperAdminPermission("tenants"), toggleTenant);
router.delete("/api/tenants/:id", superAdminAuth, requireSuperAdminPermission("tenants"), deleteTenant);
router.get("/api/dashboard/stats", superAdminAuth, requireSuperAdminPermission("dashboard"), getDashboardStats);
router.get("/api/dashboard/all-stats", superAdminAuth, requireSuperAdminPermission("dashboard"), getSuperAdminDashboardData);
router.post("/api/tenants/:id/impersonate", superAdminAuth, requireSuperAdminPermission("tenants"), impersonateTenant);

// Super Admin Platform Settings
router.get("/api/public/branding", getPublicBranding);
router.get("/api/settings", superAdminAuth, requireSuperAdminPermission("settings"), getSuperAdminSettings);
router.put("/api/settings", superAdminAuth, requireSuperAdminPermission("settings"), updateSuperAdminSettings);
router.post("/api/settings/logo", superAdminAuth, requireSuperAdminPermission("settings"), uploadPlatformLogoMiddleware.single("logo"), uploadPlatformLogo);
router.post("/api/settings/favicon", superAdminAuth, requireSuperAdminPermission("settings"), uploadPlatformLogoMiddleware.single("favicon"), uploadSuperAdminFavicon);

// Free trial signup log
router.get("/api/free-trials/analysis", superAdminAuth, requireSuperAdminPermission("analysis"), getFreeTrialAnalysis);
router.get("/api/free-trials", superAdminAuth, requireSuperAdminPermission("free_trials"), listFreeTrialSignups);
router.get("/api/free-trials/:id", superAdminAuth, requireSuperAdminPermission("free_trials"), getFreeTrialSignupDetails);
router.delete("/api/free-trials/:id", superAdminAuth, requireSuperAdminPermission("free_trials"), deleteFreeTrialSignup);

// Tenant Activity Logs — stored in the tenant's own database, viewed per-tenant
router.get("/api/tenants/:id/activity-logs", superAdminAuth, requireSuperAdminPermission("tenants"), getTenantActivityLogs);

// Manually fires the free-trial reminder/expiry cron on demand — the
// scheduled job only runs hourly (cron/freeTrialCron.js), so this lets an
// admin verify a trial-date change immediately instead of waiting for the
// next tick.
router.post("/api/free-trials/run-cron", superAdminAuth, requireSuperAdminPermission("free_trials"), async (req, res) => {
  try {
    await runFreeTrialCron();
    res.json({ success: true, message: "Free-trial cron executed" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
