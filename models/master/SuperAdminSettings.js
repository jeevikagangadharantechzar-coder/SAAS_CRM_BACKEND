import mongoose from "mongoose";
import { masterConn } from "../../config/masterDB.js";

const superAdminSettingsSchema = new mongoose.Schema(
  {
    // Branding
    platformName: { type: String, default: "TZI CRM SaaS Platform" },
    platformLogo: { type: String, default: "" },
    supportEmail: { type: String, default: "" },

    // SMTP
    smtpHost:     { type: String, default: "" },
    smtpPort:     { type: Number, default: 587 },
    smtpUser:     { type: String, default: "" },
    smtpPass:     { type: String, default: "" },
    smtpSecure:   { type: Boolean, default: false },
    smtpFromName: { type: String, default: "TZI Support" },

    // Welcome email template (default body is set at runtime from dynamicEmail.js BEAUTIFUL_WELCOME_BODY)
    welcomeSubject: { type: String, default: "Welcome to {{platformName}} — Your Login Credentials" },
    welcomeBody: { type: String, default: "" },

    // Upgrade alert
    upgradeAlertEnabled:  { type: Boolean, default: true },
    upgradeAlertEmail:    { type: String, default: "" },
  },
  { timestamps: true }
);

const SuperAdminSettings = masterConn.model("SuperAdminSettings", superAdminSettingsSchema);
export default SuperAdminSettings;
