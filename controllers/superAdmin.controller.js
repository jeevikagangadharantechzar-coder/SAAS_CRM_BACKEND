import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import SuperAdmin from "../models/master/SuperAdmin.js";

dotenv.config();

export const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const admin = await SuperAdmin.findOne({ email: email.toLowerCase() });
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

    res.json({ token, admin: { id: admin._id, name: admin.name, email: admin.email } });
  } catch (err) {
    console.error("SuperAdmin login error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

import { verifyMfaToken } from "../utils/mfa.js";

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
    const admin = await SuperAdmin.findById(req.user.id);
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