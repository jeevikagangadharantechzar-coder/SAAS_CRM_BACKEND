import bcrypt from "bcryptjs";
import crypto from "crypto";
import dotenv from "dotenv";
import SuperAdmin from "../models/master/SuperAdmin.js";
import SuperAdminRole from "../models/master/SuperAdminRole.js";
import sendEmail from "../utils/sendEmail.js";

dotenv.config();

function generatePassword(length = 12) {
  const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$!";
  return Array.from(crypto.randomBytes(length))
    .map((b) => charset[b % charset.length])
    .join("");
}

function credentialEmailHtml({ name, email, password, roleName, loginUrl, isReset = false }) {
  const firstName = name.split(" ")[0];
  return `
<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; background-color: #f4f6fb; padding: 20px;">
  <div style="background-color: #ffffff; padding: 30px; border-radius: 12px; max-width: 550px; margin: 0 auto; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
    <h2 style="color: #008ecc; text-align: center;">${isReset ? "Your Password Has Been Reset" : "Welcome to the Management Console"}</h2>
    <p>Hi <strong>${firstName}</strong>,</p>
    <p>${isReset
      ? "Your Super Admin account password has been reset. Use the new credentials below to log in."
      : "A Super Admin account has been created for you. Use the credentials below to log in to the Management Console."}</p>

    <div style="background-color: #f2fbff; border: 1px solid #d0e7ff; padding: 15px; border-radius: 8px; margin: 20px 0;">
      <p style="margin: 4px 0;"><strong>Email:</strong> ${email}</p>
      <p style="margin: 4px 0;"><strong>Password:</strong> <span style="font-family: monospace; background: #fff; border: 1px solid #d0e7ff; border-radius: 4px; padding: 2px 8px;">${password}</span></p>
      <p style="margin: 4px 0;"><strong>Role:</strong> ${roleName}</p>
    </div>

    <div style="text-align: center; margin-top: 25px;">
      <a href="${loginUrl}" target="_blank" style="background-color: #008ecc; color: #ffffff; text-decoration: none; padding: 12px 30px; border-radius: 6px; font-weight: bold; display: inline-block;">Login to Management Console</a>
    </div>

    <p style="font-size: 13px; color: #555; margin-top: 25px; line-height: 1.5;">
      For security, please change your password after logging in. If you did not expect this account, contact your platform owner.
    </p>

    <p style="font-size: 11px; color: #888; margin-top: 30px; border-top: 1px solid #eee; padding-top: 15px; text-align: center;">
      © ${new Date().getFullYear()} TZI Support. All rights reserved.
    </p>
  </div>
</body>
</html>`;
}

const loginUrl = `${process.env.FRONTEND_URL || "http://localhost:3000"}/superadmin/login`;

export const listSuperAdminUsers = async (req, res) => {
  try {
    const users = await SuperAdmin.find().select("-password").populate("role").sort({ createdAt: -1 });
    res.json({ success: true, users });
  } catch (err) {
    console.error("List super admin users error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

export const createSuperAdminUser = async (req, res) => {
  try {
    const { name, email, roleId } = req.body;
    if (!name?.trim() || !email?.trim() || !roleId) {
      return res.status(400).json({ success: false, error: "Name, email, and role are required" });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await SuperAdmin.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(409).json({ success: false, error: "An account with this email already exists" });
    }

    const role = await SuperAdminRole.findById(roleId);
    if (!role) {
      return res.status(404).json({ success: false, error: "Role not found" });
    }

    const plainPassword = generatePassword();
    console.log(`[SUPERADMIN CREATION] Generated password for "${normalizedEmail}": ${plainPassword}`);
    const hashedPassword = await bcrypt.hash(plainPassword, 10);

    const admin = await SuperAdmin.create({
      name: name.trim(),
      email: normalizedEmail,
      password: hashedPassword,
      role: role._id,
    });

    sendEmail({
      to: normalizedEmail,
      subject: "Your Super Admin Account — Login Credentials",
      html: credentialEmailHtml({ name: name.trim(), email: normalizedEmail, password: plainPassword, roleName: role.name, loginUrl }),
    }).catch((err) => console.error("Super admin credential email failed:", err.message));

    const populated = await SuperAdmin.findById(admin._id).select("-password").populate("role");
    res.status(201).json({ success: true, admin: populated, message: "Super admin created. Credentials have been emailed." });
  } catch (err) {
    console.error("Create super admin user error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

export const updateSuperAdminUser = async (req, res) => {
  try {
    const { name, email, roleId } = req.body;
    const admin = await SuperAdmin.findById(req.params.id);
    if (!admin) return res.status(404).json({ success: false, error: "Super admin not found" });

    if (email) {
      const normalizedEmail = email.toLowerCase().trim();
      const existing = await SuperAdmin.findOne({ email: normalizedEmail, _id: { $ne: admin._id } });
      if (existing) {
        return res.status(409).json({ success: false, error: "An account with this email already exists" });
      }
      admin.email = normalizedEmail;
    }

    if (roleId) {
      const role = await SuperAdminRole.findById(roleId);
      if (!role) return res.status(404).json({ success: false, error: "Role not found" });
      admin.role = role._id;
    }

    if (name?.trim()) admin.name = name.trim();

    await admin.save();

    const populated = await SuperAdmin.findById(admin._id).select("-password").populate("role");
    res.json({ success: true, admin: populated, message: "Super admin updated" });
  } catch (err) {
    console.error("Update super admin user error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

export const deleteSuperAdminUser = async (req, res) => {
  try {
    if (req.params.id === String(req.superAdmin._id)) {
      return res.status(400).json({ success: false, error: "You cannot delete your own account" });
    }

    const admin = await SuperAdmin.findById(req.params.id);
    if (!admin) return res.status(404).json({ success: false, error: "Super admin not found" });

    const totalCount = await SuperAdmin.countDocuments();
    if (totalCount <= 1) {
      return res.status(400).json({ success: false, error: "Cannot delete the last remaining super admin account" });
    }

    await SuperAdmin.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Super admin deleted" });
  } catch (err) {
    console.error("Delete super admin user error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

export const resetSuperAdminUserPassword = async (req, res) => {
  try {
    const admin = await SuperAdmin.findById(req.params.id).populate("role");
    if (!admin) return res.status(404).json({ success: false, error: "Super admin not found" });

    const plainPassword = generatePassword();
    admin.password = await bcrypt.hash(plainPassword, 10);
    await admin.save();

    sendEmail({
      to: admin.email,
      subject: "Your Super Admin Password Has Been Reset",
      html: credentialEmailHtml({ name: admin.name, email: admin.email, password: plainPassword, roleName: admin.role?.name || "—", loginUrl, isReset: true }),
    }).catch((err) => console.error("Super admin password reset email failed:", err.message));

    res.json({ success: true, message: "Password reset. New credentials have been emailed." });
  } catch (err) {
    console.error("Reset super admin password error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};
