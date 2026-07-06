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
import {
  getPublicBranding,
  getSettings as getSuperAdminSettings,
  updateSettings as updateSuperAdminSettings,
  uploadPlatformLogo,
  uploadSuperAdminFavicon,
} from "../controllers/superAdminSettings.controller.js";
import uploadPlatformLogoMiddleware from "../middlewares/uploadPlatformLogo.js";

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

// Super Admin Platform Settings
router.get("/api/public/branding", getPublicBranding);
router.get("/api/settings",  superAdminAuth, getSuperAdminSettings);
router.put("/api/settings",  superAdminAuth, updateSuperAdminSettings);
router.post("/api/settings/logo",    superAdminAuth, uploadPlatformLogoMiddleware.single("logo"),    uploadPlatformLogo);
router.post("/api/settings/favicon", superAdminAuth, uploadPlatformLogoMiddleware.single("favicon"), uploadSuperAdminFavicon);

export default router;
