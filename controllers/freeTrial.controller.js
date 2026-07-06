import dotenv from "dotenv";
import Tenant from "../models/master/Tenant.js";
import SubscriptionPlan from "../models/master/SubscriptionPlan.model.js";
import FreeTrialSignup from "../models/master/FreeTrialSignup.js";
import { getTenantDB } from "../config/tenantDB.js";
import { getTenantModels } from "../models/tenant/index.js";
import sendEmail from "../utils/sendEmail.js";
import defaultEmailTemplates from "../seeder/data/defaultEmailTemplates.js";
import userService from "../services/user.service.js";

dotenv.config();

const RESERVED_SLUGS = new Set(["superadmin", "api", "admin", "www", "static", "public"]);
const TRIAL_DAYS = 14;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function slugify(businessName) {
  return businessName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function formatDate(date) {
  return new Date(date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function trialWelcomeEmailHtml({ name, email, password, businessName, loginUrl, trialEndDate }) {
  const firstName = name.split(" ")[0];
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Welcome to your 14 Days Free Trial</title>
</head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="580" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#38BDF8 0%,#3B82F6 100%);padding:36px 40px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;letter-spacing:-0.5px;">
                Welcome to Your 14 Days Free Trial
              </h1>
              <p style="margin:8px 0 0;color:#dbeafe;font-size:14px;">Business Name: ${businessName}</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 40px;">
              <p style="margin:0 0 20px;color:#333;font-size:16px;">Hi <strong>${firstName}</strong>,</p>
              <p style="margin:0 0 28px;color:#555;font-size:15px;line-height:1.6;">
                Thank you for signing up for <strong>${businessName}</strong>. Your workspace is ready and your 14 days free trial has started. Use the email and password below to log in and start exploring the CRM.
              </p>

              <!-- Credentials box -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4ff;border:1px solid #d0dcff;border-radius:8px;margin-bottom:32px;">
                <tr>
                  <td style="padding:24px 28px;">
                    <p style="margin:0 0 14px;font-size:13px;font-weight:600;color:#3B82F6;text-transform:uppercase;letter-spacing:0.8px;">Login Credentials</p>
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding:6px 0;color:#666;font-size:14px;width:90px;">Email</td>
                        <td style="padding:6px 0;color:#111;font-size:14px;font-weight:600;">${email}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;color:#666;font-size:14px;">Password</td>
                        <td style="padding:6px 0;">
                          <span style="background:#fff;border:1px solid #d0dcff;border-radius:4px;padding:4px 12px;font-family:monospace;font-size:15px;color:#3B82F6;font-weight:700;letter-spacing:1px;">${password}</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 24px;color:#555;font-size:15px;line-height:1.6;">
                Use this email and password to log in at the link below and start using your 14 days free trial version.
              </p>

              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding-bottom:28px;">
                    <a href="${loginUrl}" target="_blank"
                       style="display:inline-block;background:linear-gradient(135deg,#38BDF8 0%,#3B82F6 100%);color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;padding:16px 44px;border-radius:8px;letter-spacing:0.3px;box-shadow:0 4px 12px rgba(59,130,246,0.35);">
                      Login to Start Your Free Trial →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0;color:#888;font-size:13px;line-height:1.6;border-top:1px solid #eee;padding-top:20px;">
                Your free trial is valid through <strong>${trialEndDate}</strong>. After that, you'll need to upgrade your plan to keep using the CRM.<br/>
                If you did not request this account, please contact our support team.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f9fafc;padding:20px 40px;text-align:center;border-top:1px solid #eee;">
              <p style="margin:0;color:#aaa;font-size:12px;">© ${new Date().getFullYear()} TZI Support. All rights reserved.</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export const validateFreeTrialSignup = (req, res, next) => {
  const { name, email, password, businessName } = req.body;

  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ success: false, error: "Name is required.", code: "VALIDATION_ERROR" });
  }

  if (!email || typeof email !== "string" || !EMAIL_REGEX.test(email.trim())) {
    return res.status(400).json({ success: false, error: "A valid business email is required.", code: "VALIDATION_ERROR" });
  }

  if (!password || typeof password !== "string" || password.length < 6) {
    return res.status(400).json({ success: false, error: "Password is required and must be at least 6 characters.", code: "VALIDATION_ERROR" });
  }

  if (!businessName || typeof businessName !== "string" || !businessName.trim()) {
    return res.status(400).json({ success: false, error: "Business name is required.", code: "VALIDATION_ERROR" });
  }

  next();
};

export const signupFreeTrial = async (req, res) => {
  try {
    const { name, email, password, businessName, industry = "", country = "", subscriptionPackage = "" } = req.body;

    const adminEmail = email.toLowerCase().trim();
    const slug = slugify(businessName);

    if (!slug || RESERVED_SLUGS.has(slug)) {
      return res.status(400).json({ success: false, error: "Please enter a valid business name.", code: "VALIDATION_ERROR" });
    }

    const existingEmail = await Tenant.findOne({ adminEmail });
    if (existingEmail) {
      return res.status(409).json({
        success: false,
        error: "This email is already registered. Please use a different email address.",
        field: "email",
      });
    }

    const existingSlug = await Tenant.findOne({ slug });
    if (existingSlug) {
      return res.status(409).json({
        success: false,
        error: "This business name is already taken. Please choose another one.",
        field: "businessName",
      });
    }

    const dbName = `crm_${slug}`;
    const now = new Date();
    const planEndDate = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

    // Best-effort match of the selected package to a real subscription plan (non-blocking)
    let matchedPlan = null;
    if (subscriptionPackage) {
      matchedPlan = await SubscriptionPlan.findOne({
        plan_name: new RegExp(`^${subscriptionPackage}$`, "i"),
      });
    }

    const tenant = await Tenant.create({
      name: businessName,
      slug,
      dbName,
      adminEmail,
      adminName: name,
      plan_id: matchedPlan ? matchedPlan._id : null,
      plan_status: "trial",
      plan_start_date: now,
      plan_end_date: planEndDate,
    });

    try {
      const tenantDB = await getTenantDB(dbName);
      const { Role, User, EmailTemplate } = getTenantModels(tenantDB);

      const adminRole = await Role.create({
        name: "Admin",
        description: "Full access",
        permissions: {
          dashboard:           true,
          leads:               true,
          create_lead:         true,
          deals_all:           true,
          create_deal:         true,
          deals_pipeline:      true,
          proposal:            true,
          invoices:            true,
          activities_calendar: true,
          activities_list:     true,
          users_roles:         true,
          email_chat:          true,
          email_campaigns:     true,
          reports:             true,
          settings:            true,
          whatsapp_chat:       true,
          streak_leaderboard:  true,
        },
      });

      await Role.create({
        name: "Sales",
        description: "Limited access",
        permissions: {
          dashboard:           true,
          leads:               true,
          create_lead:         true,
          deals_all:           true,
          create_deal:         true,
          deals_pipeline:      true,
          proposal:            true,
          invoices:            true,
          activities_calendar: true,
          activities_list:     true,
          users_roles:         false,
          email_chat:          true,
          email_campaigns:     false,
          reports:             false,
          settings:            false,
          whatsapp_chat:       true,
          streak_leaderboard:  true,
        },
      });

      const hashedPassword = await userService.hashPassword(password);
      await User.create({
        firstName:   name.split(" ")[0],
        lastName:    name.split(" ").slice(1).join(" ") || name.split(" ")[0],
        email:       adminEmail,
        password:    hashedPassword,
        role:        adminRole._id,
        dateOfBirth: new Date("1990-01-01"),
        status:      "Active",
      });

      await EmailTemplate.insertMany(defaultEmailTemplates);
    } catch (setupErr) {
      await Tenant.findByIdAndDelete(tenant._id);
      console.error("Free trial tenant setup failed, rolled back tenant record:", setupErr.message);
      return res.status(500).json({ success: false, error: "Could not set up your workspace: " + setupErr.message });
    }

    await FreeTrialSignup.create({
      name,
      email: adminEmail,
      businessName,
      industry,
      country,
      subscriptionPackage,
      tenant: tenant._id,
      slug,
    });

    const loginUrl = `${process.env.FRONTEND_URL}/${slug}/login`;

    sendEmail({
      to: adminEmail,
      subject: "Welcome to Your 14 Days Free Trial",
      html: trialWelcomeEmailHtml({
        name,
        email: adminEmail,
        password,
        businessName,
        loginUrl,
        trialEndDate: formatDate(planEndDate),
      }),
    }).catch(err => console.error("Free trial welcome email failed:", err.message));

    res.status(201).json({
      success: true,
      message: "Your 14 days free trial has started. Check your email for login details.",
      loginUrl,
      slug,
      trialEndsAt: planEndDate,
    });
  } catch (err) {
    console.error("Free trial signup error:", err);
    if (err.code === 11000) {
      const dupField = Object.keys(err.keyPattern || {})[0];
      if (dupField === "adminEmail") {
        return res.status(409).json({
          success: false,
          error: "This email is already registered. Please use a different email address.",
          field: "email",
        });
      }
      if (dupField === "slug") {
        return res.status(409).json({
          success: false,
          error: "This business name is already taken. Please choose another one.",
          field: "businessName",
        });
      }
      return res.status(409).json({ success: false, error: "This business name or email is already registered." });
    }
    res.status(500).json({ success: false, error: err.message || "Server error" });
  }
};
