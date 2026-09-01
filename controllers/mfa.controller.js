import SuperAdmin from "../models/master/SuperAdmin.js";
import UserLegacy from "../models/user.model.js";
import { getTenantModels } from "../models/tenant/index.js";
import { generateMfaRegistration, verifyMfaToken } from "../utils/mfa.js";

// --- SuperAdmin MFA Handlers ---

export const generateSuperAdminMfa = async (req, res) => {
  try {
    const admin = await SuperAdmin.findById(req.superAdmin.id);
    if (!admin) return res.status(404).json({ error: "Admin not found" });

    const { secret, qrCodeDataUrl } = await generateMfaRegistration(admin.email, "SuperAdmin - TZI CRM");
    
    // Temporarily store the secret until verified
    admin.mfaSecret = secret;
    await admin.save();

    res.json({ qrCode: qrCodeDataUrl, secret });
  } catch (err) {
    console.error("Error generating SuperAdmin MFA:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const verifyAndEnableSuperAdminMfa = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "Token is required" });

    const admin = await SuperAdmin.findById(req.superAdmin.id);
    if (!admin || !admin.mfaSecret) return res.status(400).json({ error: "MFA setup not initiated" });

    const isValid = verifyMfaToken(admin.mfaSecret, token);
    if (!isValid) return res.status(400).json({ error: "Invalid MFA code" });

    admin.isMfaEnabled = true;
    await admin.save();

    res.json({ message: "MFA enabled successfully" });
  } catch (err) {
    console.error("Error verifying SuperAdmin MFA:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const disableSuperAdminMfa = async (req, res) => {
  try {
    const admin = await SuperAdmin.findById(req.superAdmin.id);
    if (!admin) return res.status(404).json({ error: "Admin not found" });

    admin.isMfaEnabled = false;
    admin.mfaSecret = undefined;
    await admin.save();

    res.json({ message: "MFA disabled successfully" });
  } catch (err) {
    console.error("Error disabling SuperAdmin MFA:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// --- Tenant User MFA Handlers ---

export const generateUserMfa = async (req, res) => {
  try {
    const User = req.tenantDB ? getTenantModels(req.tenantDB).User : UserLegacy;
    const user = await User.findById(req.user._id || req.user.id).populate("role");
    if (!user) return res.status(404).json({ error: "User not found" });

    if (user.role && user.role.name && user.role.name.toLowerCase() === "sales") {
      return res.status(403).json({ error: "MFA setup is not allowed for Sales users" });
    }

    const { secret, qrCodeDataUrl } = await generateMfaRegistration(user.email, "TZI CRM");
    
    user.mfaSecret = secret;
    await user.save();

    res.json({ qrCode: qrCodeDataUrl, secret });
  } catch (err) {
    console.error("Error generating User MFA:", err);
    res.status(500).json({ error: "Server error", details: err.message, stack: err.stack });
  }
};

export const verifyAndEnableUserMfa = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "Token is required" });

    const User = req.tenantDB ? getTenantModels(req.tenantDB).User : UserLegacy;
    const user = await User.findById(req.user._id || req.user.id).populate("role");
    if (!user || !user.mfaSecret) return res.status(400).json({ error: "MFA setup not initiated" });

    if (user.role && user.role.name && user.role.name.toLowerCase() === "sales") {
      return res.status(403).json({ error: "MFA setup is not allowed for Sales users" });
    }

    const isValid = verifyMfaToken(user.mfaSecret, token);
    if (!isValid) return res.status(400).json({ error: "Invalid MFA code" });

    user.isMfaEnabled = true;
    await user.save();

    res.json({ message: "MFA enabled successfully" });
  } catch (err) {
    console.error("Error verifying User MFA:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const disableUserMfa = async (req, res) => {
  try {
    const User = req.tenantDB ? getTenantModels(req.tenantDB).User : UserLegacy;
    const user = await User.findById(req.user._id || req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    user.isMfaEnabled = false;
    user.mfaSecret = undefined;
    await user.save();

    res.json({ message: "MFA disabled successfully" });
  } catch (err) {
    console.error("Error disabling User MFA:", err);
    res.status(500).json({ error: "Server error" });
  }
};
