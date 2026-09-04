import express from "express";
import indexControllers from "../controllers/index.controllers.js";
import {
  protect,
  adminOrSales,
  adminOrAssigned,
  adminCreateOnly,
  adminOrSelf,
} from "../middlewares/auth.middleware.js";
import upload from "../middlewares/upload.js";
import { getTenantModels } from "../models/tenant/index.js";
import UserLegacy from "../models/user.model.js";
import checkPlanLimit from "../middlewares/checkPlanLimit.js";
import checkPlanFeature from "../middlewares/checkPlanFeature.js";
import {
  generateUserMfa,
  verifyAndEnableUserMfa,
  disableUserMfa
} from "../controllers/mfa.controller.js";

const router = express.Router();

router.post("/login", indexControllers.usersController.loginUser);
router.post("/login/verify-mfa", indexControllers.usersController.verifyMfaLogin);

// MFA Routes
router.post("/mfa/setup", protect, generateUserMfa);
router.post("/mfa/enable", protect, verifyAndEnableUserMfa);
router.post("/mfa/disable", protect, disableUserMfa);

router.post("/forgot-password", indexControllers.usersController.forgotPassword);
router.post("/reset-password/:token", indexControllers.usersController.resetPassword);

// Polled by a client waiting on device-login approval — no token exists yet
// at this point, so this stays public (tenant is still resolved via the URL
// slug by the resolveTenant middleware applied ahead of this router).
router.get("/device-request/:id/status", indexControllers.usersController.getDeviceRequestStatus);

// Admin-only device login approval queue
router.get("/device-requests", protect, adminCreateOnly, checkPlanFeature("device_login_requests"), indexControllers.usersController.listDeviceRequests);
router.patch("/device-requests/:id/approve", protect, adminCreateOnly, checkPlanFeature("device_login_requests"), indexControllers.usersController.approveDeviceRequest);
router.patch("/device-requests/:id/reject", protect, adminCreateOnly, checkPlanFeature("device_login_requests"), indexControllers.usersController.rejectDeviceRequest);

router.get("/me", protect, indexControllers.usersController.getMe);
router.post("/dismiss-plan-update", protect, indexControllers.usersController.dismissPlanUpdate);

// Full user list — used by the Users & Roles management page, but also by
// many unrelated features (Assign To dropdowns, Trash/Tasks/Targets/Proposal
// filters, Reports, Schedule's "view as user" filter, etc.) that have no
// connection to user management at all. Same entanglement as the bare
// /sales endpoint below — no clean way to gate this by "users_roles" without
// breaking those other features, so it's intentionally left ungated by role
// permission (still requires being logged in as Admin or Sales).
router.get("/", protect, adminOrSales, indexControllers.usersController.getUsers);

router.get(
  "/sales",
  protect,
  adminOrSales,
  async (req, res) => {
    try {
      const User = req.tenantDB ? getTenantModels(req.tenantDB).User : UserLegacy;
      const users = await User.find()
        .populate("role", "name")
        .select("firstName lastName email role");
      const salesUsers = users.filter(u => u.role?.name?.toLowerCase() === "sales");
      res.json({ users: salesUsers });
    } catch (error) {
      console.error("Error fetching sales users:", error);
      res.status(500).json({ message: "Server error", error: error.message });
    }
  }
);

router.post(
  "/create",
  protect,
  adminCreateOnly,
  checkPlanFeature("users_roles"),
  checkPlanLimit("max_users_per_tenant"),
  upload.single("profileImage"),
  indexControllers.usersController.createUser,
);

router.put(
  "/update-user/:id",
  protect,
  adminOrSelf,
  checkPlanFeature("users_roles"),
  upload.single("profileImage"),
  indexControllers.usersController.updateUser,
);

router.delete(
  "/delete-user/:id",
  protect,
  adminCreateOnly,
  checkPlanFeature("users_roles"),
  indexControllers.usersController.deleteUser,
);

router.post("/logout", protect, indexControllers.usersController.logoutUser);

router.put(
  "/update-password",
  protect,
  indexControllers.usersController.updatePassword,
);

export default router;
