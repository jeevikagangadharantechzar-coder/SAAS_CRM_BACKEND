import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import SuperAdmin from "../models/master/SuperAdmin.js";
import { verifyMfaToken } from "../utils/mfa.js";
dotenv.config();

export const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const admin = await SuperAdmin.findOne({ email: email.toLowerCase() }).populate("role");
    if (!admin) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const match = await bcrypt.compare(password, admin.password);
    if (!match) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    if (admin.isMfaEnabled) {
      // Issue a temporary token for MFA verification
      const tempToken = jwt.sign(
        { id: admin._id, mfaPending: true },
        process.env.SUPERADMIN_JWT_SECRET,
        { expiresIn: "5m" }
      );
      return res.json({ mfaRequired: true, tempToken });
    }

    const token = jwt.sign(
      { id: admin._id, email: admin.email },
      process.env.SUPERADMIN_JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      admin: {
        id: admin._id,
        name: admin.name,
        email: admin.email,
        role: admin.role
          ? { id: admin.role._id, name: admin.role.name, permissions: admin.role.permissions }
          : null,
      },
    });
  } catch (err) {
    console.error("SuperAdmin login error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const verifyMfaLogin = async (req, res) => {
  try {
    const { tempToken, mfaCode } = req.body;
    if (!tempToken || !mfaCode) {
      return res.status(400).json({ error: "Token and MFA code are required" });
    }

    let decoded;
    try {
      decoded = jwt.verify(tempToken, process.env.SUPERADMIN_JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: "Invalid or expired temporary token" });
    }

    if (!decoded.mfaPending) {
      return res.status(400).json({ error: "Invalid token type" });
    }

    const admin = await SuperAdmin.findById(decoded.id);
    if (!admin) {
      return res.status(404).json({ error: "Admin not found" });
    }

    if (!admin.isMfaEnabled || !admin.mfaSecret) {
      return res.status(400).json({ error: "MFA is not enabled for this account" });
    }

    const isValid = verifyMfaToken(admin.mfaSecret, mfaCode);
    if (!isValid) {
      return res.status(401).json({ error: "Invalid MFA code" });
    }

    const token = jwt.sign(
      { id: admin._id, email: admin.email },
      process.env.SUPERADMIN_JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ token, admin: { id: admin._id, name: admin.name, email: admin.email } });
  } catch (err) {
    console.error("SuperAdmin MFA verify error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const getMe = async (req, res) => {
  try {
    const admin = req.superAdmin;
    if (!admin) return res.status(404).json({ error: "Admin not found" });

    res.json({
      id: admin._id,
      name: admin.name,
      email: admin.email,
      isMfaEnabled: admin.isMfaEnabled || false,
    });
  } catch (err) {
    console.error("SuperAdmin getMe error:", err);
    res.status(500).json({ error: "Server error" });
  }
};
const formatProfile = (admin) => ({
  id: admin._id,
  name: admin.name,
  email: admin.email,
  role: admin.role
    ? { id: admin.role._id, name: admin.role.name, permissions: admin.role.permissions }
    : null,
});

export const getProfile = async (req, res) => {
  try {
    // req.superAdmin (attached by superAdminAuth) is already fresh + role-populated
    res.json({ success: true, admin: formatProfile(req.superAdmin) });
  } catch (err) {
    console.error("Get super admin profile error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

export const updateProfile = async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name?.trim() || !email?.trim()) {
      return res.status(400).json({ success: false, error: "Name and email are required" });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await SuperAdmin.findOne({ email: normalizedEmail, _id: { $ne: req.superAdmin._id } });
    if (existing) {
      return res.status(409).json({ success: false, error: "An account with this email already exists" });
    }

    const admin = await SuperAdmin.findById(req.superAdmin._id).populate("role");
    admin.name = name.trim();
    admin.email = normalizedEmail;
    await admin.save();

    res.json({ success: true, admin: formatProfile(admin), message: "Profile updated successfully" });
  } catch (err) {
    console.error("Update super admin profile error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

export const changeOwnPassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, error: "Current and new password are required" });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, error: "New password must be at least 8 characters" });
    }

    // req.superAdmin has the password field stripped (.select("-password") in
    // superAdminAuth) — re-fetch with it to verify the current password.
    const admin = await SuperAdmin.findById(req.superAdmin._id);
    const match = await bcrypt.compare(currentPassword, admin.password);
    if (!match) {
      return res.status(401).json({ success: false, error: "Current password is incorrect" });
    }

    admin.password = await bcrypt.hash(newPassword, 10);
    await admin.save();

    res.json({ success: true, message: "Password updated successfully" });
  } catch (err) {
    console.error("Change super admin password error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};
