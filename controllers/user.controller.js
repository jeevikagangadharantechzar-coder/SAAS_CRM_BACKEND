import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import fs from "fs";
import sendEmail from "../utils/sendEmail.js";
import crypto from "crypto";
import userService from "../services/user.service.js";
import { getTenantModels } from "../models/tenant/index.js";

// Legacy fallback for non-tenant routes
import UserLegacy from "../models/user.model.js";
import StreakLegacy from "../models/streak.model.js";
import Tenant from "../models/master/Tenant.js";
import { getTenantDB } from "../config/tenantDB.js";

dotenv.config();

const generateToken = (id, tenant = null, tokenVersion = 0) =>
  jwt.sign(
    {
      id,
      tokenVersion,
      ...(tenant
        ? { dbName: tenant.dbName, slug: tenant.slug, tenantId: tenant._id }
        : {}),
    },
    process.env.SECRET_KEY,
    { expiresIn: "1d" }
  );


const createUser = async (req, res) => {
    try {
      const User = req.tenantDB ? getTenantModels(req.tenantDB).User : UserLegacy;
      const {
        firstName, lastName, email, password, mobileNumber,
        role, status, gender, address, dateOfBirth,
      } = req.body;

      // Limit check
      if (req.tenant) {
        const tenant = await Tenant.findById(req.tenant._id).populate("plan_id");
        if (tenant && tenant.plan_id) {
          const maxUsers = tenant.plan_id.max_users_per_tenant;
          const activeUsersCount = await User.countDocuments();
          if (maxUsers > 0 && activeUsersCount >= maxUsers) {
            return res.status(403).json({
              success: false,
              limitExceeded: true,
              message: `User limit reached (${maxUsers} max). Please upgrade your plan.`
            });
          }
        }
      }
      
      if (dateOfBirth && !userService.validateAge(dateOfBirth)) {
        return res.status(400).json({ success: false, message: "Date of birth must be valid. User must be between 18 and 100 years old" });
      }

      const hashedPassword = await userService.hashPassword(password);
      const profileImage = req.file ? req.file.filename : null;
      const user = await User.create({
        firstName, lastName, email, password: hashedPassword, mobileNumber,
        role, status, gender, address, dateOfBirth, profileImage,
      });
      res.status(201).json(user);
    } catch (err) {
      if (req.file) fs.unlinkSync(req.file.path);
      res.status(500).json({ message: err.message });
    }
};

const getUsers = async (req, res) => {
    try {
      const User = req.tenantDB ? getTenantModels(req.tenantDB).User : UserLegacy;
      const users = await User.find({ email: { $ne: "admin@gmail.com" } }).populate("role");
      res.json({ users, total: users.length });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
};

const getMe = async (req, res) => {
    try {
      const User = req.tenantDB ? getTenantModels(req.tenantDB).User : UserLegacy;
      const user = await User.findById(req.user.id).populate("role");
      if (!user) return res.status(404).json({ message: "User not found" });

      let tenantLimit = null;
      if (req.tenant) {
        const tenant = await Tenant.findById(req.tenant._id).populate("plan_id");
        if (tenant && tenant.plan_id) {
          tenantLimit = {
            plan_name: tenant.plan_id.plan_name,
            max_users: tenant.plan_id.max_users_per_tenant,
            plan_end_date: tenant.plan_end_date,
          };
        }
      }

      res.json({
        _id: user._id,
        name: `${user.firstName} ${user.lastName}`,
        email: user.email,
        profileImage: user.profileImage,
        role: user.role,
        tenantLimit,
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
};

const updateUser = async (req, res) => {
    try {
      const User = req.tenantDB ? getTenantModels(req.tenantDB).User : UserLegacy;
      const { id } = req.params;
      const {
        firstName, lastName, email, mobileNumber,
        role, status, gender, address, dateOfBirth,
      } = req.body;

      const user = await User.findById(id);
      if (!user) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(404).json({ message: "User not found" });
      }

      if (dateOfBirth && !userService.validateAge(dateOfBirth)) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(400).json({ success: false, message: "Date of birth must be valid. User must be between 18 and 100 years old" });
      }

      let profileImage = user.profileImage;
      if (req.file) {
        if (user.profileImage) {
          const oldPath = `uploads/users/${user.profileImage}`;
          if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }
        profileImage = req.file.filename;
      }

      const updatedUser = await User.findByIdAndUpdate(
        id,
        { firstName, lastName, email, mobileNumber, role, status, gender, address, dateOfBirth, profileImage },
        { new: true, runValidators: true }
      ).populate("role");

      res.json(updatedUser);
    } catch (err) {
      if (req.file) fs.unlinkSync(req.file.path);
      res.status(500).json({ message: err.message });
    }
};

const deleteUser = async (req, res) => {
    try {
      const User = req.tenantDB ? getTenantModels(req.tenantDB).User : UserLegacy;
      const { id } = req.params;
      const deletedUser = await User.findByIdAndDelete(id);
      if (!deletedUser) return res.status(404).json({ message: "User not found" });
      res.json({ message: "User deleted successfully" });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
};

const loginUser = async (req, res) => {
    try {
      const { email, password, tenantSlug } = req.body;
      let User;
      let tenant = null;

      if (req.tenantDB) {
        User = getTenantModels(req.tenantDB).User;
        tenant = req.tenant || null;
      } else if (tenantSlug) {
        // Resolve tenant directly using the slug from request body (Mobile App unified endpoint)
        tenant = await Tenant.findOne({ slug: tenantSlug.toLowerCase().trim() });
        if (!tenant) {
          return res.status(404).json({ success: false, message: "Workspace not found" });
        }
        const db = await getTenantDB(tenant.dbName);
        req.tenantDB = db;
        User = getTenantModels(db).User;
      } else {
        // Global login without slug in URL or body — falls back to master/superadmin model
        User = UserLegacy;
      }

      const user = await User.findOne({ email: email.toLowerCase().trim() }).populate("role").select("+password");
      if (!user)
        return res.status(401).json({ success: false, message: "Invalid email or password" });

      const isMatch = await userService.matchPassword(password, user.password);
      if (!isMatch)
        return res.status(401).json({ success: false, message: "Invalid email or password" });

      if (tenant && (tenant.plan_status === "expired" || (tenant.plan_end_date && new Date() > new Date(tenant.plan_end_date)))) {
        return res.status(403).json({
          success: false,
          planExpired: true,
          message: "Your subscription validity has expired. Please contact superadmin to renew."
        });
      }

      let isDbRefreshed = false;
      if (tenant) {
        isDbRefreshed = tenant.isDbRefreshed || false;
        if (isDbRefreshed) {
          tenant.isDbRefreshed = false;
          await tenant.save();
        }
      }

      if (!user.loginHistory) user.loginHistory = [];
      user.loginHistory.push({ login: new Date() });
      await user.save({ validateBeforeSave: false });

      // Update streak document in the tenant (or legacy) database
      try {
        const Streak = req.tenantDB ? getTenantModels(req.tenantDB).Streak : StreakLegacy;
        const today = new Date();
        const todayStr = today.toDateString();
        let streakDoc = await Streak.findOne({ userId: user._id });
        if (!streakDoc) {
          streakDoc = await Streak.create({ userId: user._id, currentStreak: 0, longestStreak: 0, productiveDays: 0 });
        }
        const lastStr = streakDoc.lastLoginDate ? new Date(streakDoc.lastLoginDate).toDateString() : null;
        if (lastStr !== todayStr) {
          const yesterday = new Date(today);
          yesterday.setDate(yesterday.getDate() - 1);
          streakDoc.currentStreak = lastStr === yesterday.toDateString() ? (streakDoc.currentStreak || 0) + 1 : 1;
          if (streakDoc.currentStreak > (streakDoc.longestStreak || 0)) streakDoc.longestStreak = streakDoc.currentStreak;
          streakDoc.productiveDays = (streakDoc.productiveDays || 0) + 1;
          streakDoc.lastLoginDate = today;
          await streakDoc.save();
        }
      } catch (streakErr) {
        console.error("Streak update failed (non-fatal):", streakErr.message);
      }

      res.status(200).json({
        success: true,
        message: "Login successful",
        _id: user._id,
        name: `${user.firstName} ${user.lastName}`,
        email: user.email,
        profileImage: user.profileImage,
        role: user.role,
        isDbRefreshed,
        token: generateToken(user._id, tenant, user.tokenVersion || 0),
      });
    } catch (error) {
      console.error("Login error:", error);
      res.status(500).json({ success: false, message: error.message });
    }
};

const logoutUser = async (req, res) => {
    try {
      const User = req.tenantDB ? getTenantModels(req.tenantDB).User : UserLegacy;
      const user = await User.findById(req.user.id);
      if (!user) return res.status(404).json({ message: "User not found" });

      // Invalidate current token by incrementing version
      user.tokenVersion = (user.tokenVersion || 0) + 1;

      if (!user.loginHistory) user.loginHistory = [];
      const latestEntry = [...user.loginHistory].reverse().find((e) => !e.logout);
      if (latestEntry) {
        latestEntry.logout = new Date();
      }
      await user.save({ validateBeforeSave: false });
      res.json({ message: "Logout successful" });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: error.message });
    }
};

const updatePassword = async (req, res) => {
    try {
      const User = req.tenantDB ? getTenantModels(req.tenantDB).User : UserLegacy;
      const { currentPassword, newPassword } = req.body;
      const userId = req.user.id;

      const user = await User.findById(userId).select("+password");
      if (!user) return res.status(404).json({ message: "User not found" });
      if (!(await userService.matchPassword(currentPassword, user.password)))
        return res.status(401).json({ message: "Current password is incorrect" });

      user.password = await userService.hashPassword(newPassword);
      await user.save();
      res.json({ message: "Password updated successfully" });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
};

const forgotPassword = async (req, res) => {
    try {
      const User = req.tenantDB ? getTenantModels(req.tenantDB).User : UserLegacy;
      const { email } = req.body;
      if (!email) return res.status(400).json({ success: false, message: "Email is required" });

      const user = await User.findOne({ email: email.toLowerCase().trim() });
      if (!user) return res.status(404).json({ success: false, message: "User not found" });

      const { resetToken, hashedToken, expireDate } = userService.generateResetPasswordToken();
      user.resetPasswordToken = hashedToken;
      user.resetPasswordExpire = expireDate;
      await user.save({ validateBeforeSave: false });

      const frontendUrl = process.env.FRONTEND_URL;
      if (!frontendUrl)
        return res.status(500).json({ success: false, message: "FRONTEND_URL not configured" });

      const resetUrl = req.tenant
        ? `${frontendUrl}/${req.tenant.slug}/reset-password/${resetToken}`
        : `${frontendUrl}/reset-password/${resetToken}`;
      const message = `
        <h2>Password Reset</h2>
        <p>You requested password reset</p>
        <p>Click below link:</p>
        <a href="${resetUrl}" target="_blank">${resetUrl}</a>
        <p>This link expires in 15 minutes.</p>
      `;

      await sendEmail({ to: user.email, subject: "Password Reset", html: message });
      return res.status(200).json({ success: true, message: "Reset link sent successfully" });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ success: false, message: "Something went wrong" });
    }
};

const resetPassword = async (req, res) => {
    try {
      const User = req.tenantDB ? getTenantModels(req.tenantDB).User : UserLegacy;
      const token = req.params.token;
      const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

      const user = await User.findOne({
        resetPasswordToken: hashedToken,
        resetPasswordExpire: { $gt: Date.now() },
      });

      if (!user)
        return res.status(400).json({ success: false, message: "Invalid or expired token" });

      user.password = await userService.hashPassword(req.body.password);
      user.resetPasswordToken  = undefined;
      user.resetPasswordExpire = undefined;
      await user.save();

      res.status(200).json({ success: true, message: "Password reset successful" });
    } catch (error) {
      console.log(error);
      res.status(500).json({ success: false, message: error.message });
    }
};


export default {
  createUser,
  getUsers,
  getMe,
  updateUser,
  deleteUser,
  loginUser,
  logoutUser,
  updatePassword,
  forgotPassword,
  resetPassword
};
