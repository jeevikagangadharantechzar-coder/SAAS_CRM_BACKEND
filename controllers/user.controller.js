import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import fs from "fs";
import sendEmail from "../utils/sendEmail.js";
import crypto from "crypto";
import userService from "../services/user.service.js";
import { getTenantModels } from "../models/tenant/index.js";
import { sendNotificationToAdmins } from "../services/notificationService.js";
import { buildWelcomeEmail, sendWelcomeEmail } from "../utils/dynamicEmail.js";
import { sendEmailWithAttachments } from "../utils/gmailService.js";

// Legacy fallback for non-tenant routes
import UserLegacy from "../models/user.model.js";
import StreakLegacy from "../models/streak.model.js";
import SettingsLegacy from "../models/Settings.js";
import Tenant from "../models/master/Tenant.js";
import { getTenantDB } from "../config/tenantDB.js";

dotenv.config();

const generateToken = (id, tenant = null, tokenVersion = 0, sessionId = null) =>
  jwt.sign(
    {
      id,
      tokenVersion,
      ...(sessionId ? { sessionId } : {}),
      ...(tenant
        ? { dbName: tenant.dbName, slug: tenant.slug, tenantId: tenant._id }
        : {}),
    },
    process.env.SECRET_KEY,
    { expiresIn: "1d" }
  );

/**
 * Enforces "one web + one mobile device at a time" for Sales users only.
 * Returns:
 *   { ok: true, sessionId }                — slot free or same device, proceed with login
 *   { ok: false, pendingId, message }       — a session of this deviceType is already
 *                                             active elsewhere; admin approval required
 * Admins and any role other than Sales are completely unaffected (returns
 * { ok: true, sessionId: null } immediately) — this only ever runs for Sales,
 * and only when the caller actually provides deviceType/deviceId.
 */
const resolveDeviceSlot = async (req, user, tenantDB) => {
  const roleName = (user.role?.name || "").toLowerCase();
  const { deviceType, deviceId, deviceLabel } = req.body;

  if (roleName !== "sales" || !tenantDB || !deviceType || !deviceId) {
    return { ok: true, sessionId: null };
  }

  const { DeviceSession } = getTenantModels(tenantDB);

  // Same device re-authenticating (token expired, manual re-login, etc.) —
  // always allowed, just rotate the session id.
  const existingForDevice = await DeviceSession.findOne({
    userId: user._id, deviceId, status: "active",
  });
  if (existingForDevice) {
    const sessionId = crypto.randomUUID();
    existingForDevice.sessionId = sessionId;
    existingForDevice.lastActiveAt = new Date();
    existingForDevice.deviceLabel = deviceLabel || existingForDevice.deviceLabel;
    await existingForDevice.save();
    return { ok: true, sessionId };
  }

  // Is the slot for this deviceType (web/mobile) already occupied by a
  // different device?
  const activeOfType = await DeviceSession.findOne({
    userId: user._id, deviceType, status: "active",
  });

  if (!activeOfType) {
    const sessionId = crypto.randomUUID();
    await DeviceSession.create({
      userId: user._id, deviceType, deviceId, deviceLabel: deviceLabel || "",
      sessionId, status: "active", requestedAt: new Date(), decidedAt: new Date(),
      lastActiveAt: new Date(), ipAddress: req.ip || "",
    });
    return { ok: true, sessionId };
  }

  // Slot occupied by another device — needs admin approval.
  const pending = await DeviceSession.create({
    userId: user._id, deviceType, deviceId, deviceLabel: deviceLabel || "",
    sessionId: null, status: "pending", requestedAt: new Date(), ipAddress: req.ip || "",
  });

  sendNotificationToAdmins(
    `${user.firstName} ${user.lastName} is requesting to log in from a new ${deviceType} device (${deviceLabel || "unknown device"}).`,
    "device_login_request",
    { deviceRequestId: String(pending._id), userId: String(user._id), deviceType },
    { title: "Device Login Request", referenceId: String(pending._id) },
    [],
    tenantDB
  ).catch((err) => console.error("Device login request notification error:", err));

  return {
    ok: false,
    pendingId: pending._id,
    message: `You're already logged in on another ${deviceType}. Waiting for admin approval to continue here.`,
  };
};


// Sends login credentials to a newly created user. If the tenant has connected
// their own Gmail (Settings.invoiceSenderEmail — same account used for invoices),
// the email is sent as that account via the Gmail API; otherwise it falls back
// to the platform's shared mailbox (same template used for tenant welcome emails).
const sendNewUserWelcomeEmail = async ({ req, firstName, lastName, email, password }) => {
  const Settings = req.tenantDB ? getTenantModels(req.tenantDB).Settings : SettingsLegacy;
  const settings = await Settings.findOne();

  const loginUrl = req.tenant?.slug
    ? `${process.env.FRONTEND_URL}/${req.tenant.slug}/login`
    : `${process.env.FRONTEND_URL}/login`;

  const vars = {
    adminName: `${firstName} ${lastName}`.trim(),
    email,
    password,
    loginUrl,
    slug: req.tenant?.slug || "",
    brandName: settings?.companyName || undefined,
  };

  if (settings?.invoiceSenderEmail) {
    const { subject, html } = await buildWelcomeEmail({ vars });
    await sendEmailWithAttachments(email, subject, html, "", "", [], [], settings.invoiceSenderEmail);
  } else {
    await sendWelcomeEmail({ to: email, vars });
  }
};

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

      if (email) {
        const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
        if (existingUser) {
          if (req.file) fs.unlinkSync(req.file.path);
          return res.status(400).json({ success: false, message: "Email already exists" });
        }
      }

      const hashedPassword = await userService.hashPassword(password);
      const profileImage = req.file ? req.file.filename : null;
      const user = await User.create({
        firstName, lastName, email, password: hashedPassword, mobileNumber,
        role, status, gender, address, dateOfBirth, profileImage,
      });
      res.status(201).json(user);

      // Email the new user their login credentials — the password they/the admin
      // typed in the form, not a generated one. Fire-and-forget so a mail failure
      // never fails user creation. Email is optional on this form, so skip silently
      // if none was given.
      if (email) {
        sendNewUserWelcomeEmail({ req, firstName, lastName, email, password })
          .catch((err) => console.error("New user welcome email failed:", err.message));
      }
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
      let planFeatures = null;
      if (req.tenant) {
        const tenant = await Tenant.findById(req.tenant._id).populate("plan_id");
        if (tenant && tenant.plan_id) {
          tenantLimit = {
            plan_name: tenant.plan_id.plan_name,
            max_users: tenant.plan_id.max_users_per_tenant,
            plan_end_date: tenant.plan_end_date,
          };
          planFeatures = tenant.plan_id.features;
        }
      }

      res.json({
        _id: user._id,
        name: `${user.firstName} ${user.lastName}`,
        email: user.email,
        profileImage: user.profileImage,
        role: user.role,
        tenantLimit,
        currency:user.currency || null,
        planFeatures,
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
        const isTrial = tenant.plan_status === "trial";
        const expiryDate = tenant.plan_end_date
          ? new Date(tenant.plan_end_date).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
          : null;
        return res.status(403).json({
          success: false,
          planExpired: true,
          trialExpired: isTrial,
          expiryDate,
          message: isTrial
            ? "Your 14 days free trial has ended. Please upgrade your plan to continue using the CRM."
            : "Your subscription validity has expired. Please contact superadmin to renew."
        });
      }

      // One web + one mobile device at a time for Sales — a third device
      // waits on admin approval instead of logging straight in.
      const deviceSlot = await resolveDeviceSlot(req, user, req.tenantDB);
      if (!deviceSlot.ok) {
        return res.status(202).json({
          success: false,
          requiresApproval: true,
          requestId: deviceSlot.pendingId,
          message: deviceSlot.message,
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
        token: generateToken(user._id, tenant, user.tokenVersion || 0, deviceSlot.sessionId),
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

      // Sales users on a device-tracked session (req.sessionId set by protect())
      // only end THIS device's session — bumping tokenVersion here would also
      // kill their other still-legitimate device (web + mobile can both be
      // active at once). Every other role keeps the original "logout
      // everywhere" behavior via tokenVersion.
      if (req.sessionId && req.tenantDB) {
        const { DeviceSession } = getTenantModels(req.tenantDB);
        await DeviceSession.findOneAndUpdate(
          { sessionId: req.sessionId },
          { status: "revoked" }
        );
      } else {
        // Invalidate current token by incrementing version
        user.tokenVersion = (user.tokenVersion || 0) + 1;
      }

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


// Polled by the waiting client (no token yet, so this route is public) once
// it receives a 202 "requiresApproval" response from loginUser.
const getDeviceRequestStatus = async (req, res) => {
  try {
    if (!req.tenantDB) return res.status(404).json({ success: false, message: "Workspace not found" });
    const { DeviceSession, User } = getTenantModels(req.tenantDB);

    const session = await DeviceSession.findById(req.params.id);
    if (!session) return res.status(404).json({ success: false, message: "Request not found" });

    if (session.status === "pending") {
      return res.status(200).json({ success: true, status: "pending" });
    }
    if (session.status === "rejected" || session.status === "revoked") {
      return res.status(200).json({ success: true, status: "rejected" });
    }

    // Approved — mint the token now, same shape loginUser returns so the
    // client can complete login exactly as if it had succeeded immediately.
    const user = await User.findById(session.userId).populate("role");
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    return res.status(200).json({
      success: true,
      status: "active",
      _id: user._id,
      name: `${user.firstName} ${user.lastName}`,
      email: user.email,
      profileImage: user.profileImage,
      role: user.role,
      token: generateToken(user._id, req.tenant, user.tokenVersion || 0, session.sessionId),
    });
  } catch (error) {
    console.error("Get device request status error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Admin-only — list every device login request still awaiting a decision.
const listDeviceRequests = async (req, res) => {
  try {
    const { DeviceSession } = getTenantModels(req.tenantDB);
    const requests = await DeviceSession.find({ status: "pending" })
      .populate("userId", "firstName lastName email")
      .sort({ requestedAt: -1 });
    res.status(200).json({ success: true, requests });
  } catch (error) {
    console.error("List device requests error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Admin-only — approve a pending device request. Revokes whatever device of
// the same type was previously active, since only one of each is allowed.
const approveDeviceRequest = async (req, res) => {
  try {
    const { DeviceSession } = getTenantModels(req.tenantDB);
    const pending = await DeviceSession.findById(req.params.id);
    if (!pending || pending.status !== "pending")
      return res.status(404).json({ success: false, message: "Request not found or already decided" });

    await DeviceSession.updateMany(
      { userId: pending.userId, deviceType: pending.deviceType, status: "active" },
      { status: "revoked" }
    );

    pending.status = "active";
    pending.sessionId = crypto.randomUUID();
    pending.decidedAt = new Date();
    pending.decidedBy = req.user._id;
    pending.lastActiveAt = new Date();
    await pending.save();

    res.status(200).json({ success: true, message: "Device approved" });
  } catch (error) {
    console.error("Approve device request error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Admin-only — reject a pending device request.
const rejectDeviceRequest = async (req, res) => {
  try {
    const { DeviceSession } = getTenantModels(req.tenantDB);
    const pending = await DeviceSession.findById(req.params.id);
    if (!pending || pending.status !== "pending")
      return res.status(404).json({ success: false, message: "Request not found or already decided" });

    pending.status = "rejected";
    pending.decidedAt = new Date();
    pending.decidedBy = req.user._id;
    await pending.save();

    res.status(200).json({ success: true, message: "Device rejected" });
  } catch (error) {
    console.error("Reject device request error:", error);
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
  resetPassword,
  getDeviceRequestStatus,
  listDeviceRequests,
  approveDeviceRequest,
  rejectDeviceRequest,
};
