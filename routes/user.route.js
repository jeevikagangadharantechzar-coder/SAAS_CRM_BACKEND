import express from "express";
import indexControllers from "../controllers/index.controllers.js";
import {
  protect,
  adminOrSales,
  adminOrAssigned,
  adminCreateOnly,
} from "../middlewares/auth.middleware.js";
import upload from "../middlewares/upload.js";
import { getTenantModels } from "../models/tenant/index.js";
import UserLegacy from "../models/user.model.js";
import checkPlanLimit from "../middlewares/checkPlanLimit.js";

const router = express.Router();

router.post("/login", indexControllers.usersController.loginUser);
router.post("/forgot-password", indexControllers.usersController.forgotPassword);
router.post("/reset-password/:token", indexControllers.usersController.resetPassword);

router.get("/me", protect, indexControllers.usersController.getMe);

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
  checkPlanLimit("max_users_per_tenant"),
  upload.single("profileImage"),
  indexControllers.usersController.createUser,
);

router.put(
  "/update-user/:id",
  protect,
  adminCreateOnly,
  upload.single("profileImage"),
  indexControllers.usersController.updateUser,
);

router.delete(
  "/delete-user/:id",
  protect,
  adminCreateOnly,
  indexControllers.usersController.deleteUser,
);

router.post("/logout", protect, indexControllers.usersController.logoutUser);

router.put(
  "/update-password",
  protect,
  indexControllers.usersController.updatePassword,
);

export default router;
