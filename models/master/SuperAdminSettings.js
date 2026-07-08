import mongoose from "mongoose";
import { masterConn } from "../../config/masterDB.js";

const superAdminSettingsSchema = new mongoose.Schema(
  {
    // Tenant-facing branding (shown in emails and tenant login page)
    platformName: { type: String, default: "TZI CRM SaaS Platform" },
    platformLogo: { type: String, default: "" },
    supportEmail: { type: String, default: "" },

    // Super admin panel branding (tab title + favicon, independent of tenant branding)
    superAdminTitle:   { type: String, default: "" },
    superAdminFavicon: { type: String, default: "" },

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

    // Plan email template (default body is set at runtime from dynamicEmail.js BEAUTIFUL_PLAN_BODY)
    planSubject: { type: String, default: "Your {{planName}} Plan on {{platformName}}" },
    planBody: { type: String, default: "" },

    // Upgrade alert
    upgradeAlertEnabled:  { type: Boolean, default: true },
    upgradeAlertEmail:    { type: String, default: "" },
  },
  { timestamps: true }
);

const SuperAdminSettings = masterConn.model("SuperAdminSettings", superAdminSettingsSchema);
export default SuperAdminSettings;
