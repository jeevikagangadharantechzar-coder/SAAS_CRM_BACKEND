import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import Tenant from "../models/master/Tenant.js";
import UpgradeRequest from "../models/master/UpgradeRequest.js";
import SubscriptionPlan from "../models/master/SubscriptionPlan.model.js";
import { getTenantDB, dropTenantDB } from "../config/tenantDB.js";
import { getTenantModels } from "../models/tenant/index.js";
import sendEmail from "../utils/sendEmail.js";
import { sendWelcomeEmail, sendUpgradeAlertEmail } from "../utils/dynamicEmail.js";
import { emitToSuperAdmin } from "../realtime/superAdminSocket.js";
import defaultEmailTemplates from "../seeder/data/defaultEmailTemplates.js";
import userService from "../services/user.service.js";

dotenv.config();

const RESERVED_SLUGS = new Set(["superadmin", "api", "admin", "www", "static", "public"]);
const SLUG_REGEX = /^[a-z0-9-]+$/;

function generatePassword(length = 12) {
  const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$!";
  return Array.from(crypto.randomBytes(length))
    .map(b => charset[b % charset.length])
    .join("");
}

function welcomeEmailHtml({ adminName, adminEmail, password, loginUrl, tenantName }) {
  const firstName = adminName.split(" ")[0];
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Welcome to ${tenantName} CRM</title>
</head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="580" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#1a73e8 0%,#0d47a1 100%);padding:36px 40px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;letter-spacing:-0.5px;">
                Welcome to ${tenantName} CRM
              </h1>
              <p style="margin:8px 0 0;color:#c8dcff;font-size:14px;">Your workspace is ready</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 40px;">
              <p style="margin:0 0 20px;color:#333;font-size:16px;">Hi <strong>${firstName}</strong>,</p>
              <p style="margin:0 0 28px;color:#555;font-size:15px;line-height:1.6;">
                Your CRM account has been created successfully. Below are your login credentials — please keep them safe and change your password after your first login.
              </p>

              <!-- Credentials box -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4ff;border:1px solid #d0dcff;border-radius:8px;margin-bottom:32px;">
                <tr>
                  <td style="padding:24px 28px;">
                    <p style="margin:0 0 14px;font-size:13px;font-weight:600;color:#1a73e8;text-transform:uppercase;letter-spacing:0.8px;">Login Credentials</p>
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding:6px 0;color:#666;font-size:14px;width:90px;">Email</td>
                        <td style="padding:6px 0;color:#111;font-size:14px;font-weight:600;">${adminEmail}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;color:#666;font-size:14px;">Password</td>
                        <td style="padding:6px 0;">
                          <span style="background:#fff;border:1px solid #d0dcff;border-radius:4px;padding:4px 12px;font-family:monospace;font-size:15px;color:#1a73e8;font-weight:700;letter-spacing:1px;">${password}</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding-bottom:28px;">
                    <a href="${loginUrl}" target="_blank"
                       style="display:inline-block;background:linear-gradient(135deg,#1a73e8 0%,#0d47a1 100%);color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;padding:16px 44px;border-radius:8px;letter-spacing:0.3px;box-shadow:0 4px 12px rgba(26,115,232,0.35);">
                      Login to Dashboard →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0;color:#888;font-size:13px;line-height:1.6;border-top:1px solid #eee;padding-top:20px;">
                For security, please change your password immediately after logging in.<br/>
                If you did not request this account, please contact your administrator.
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

export const createTenant = async (req, res) => {
  try {
    const { name, slug, adminName, adminEmail } = req.body;
    const plainPassword = generatePassword();
    console.log(`[TENANT CREATION] Generated password for tenant "${slug}": ${plainPassword}`);

    if (!slug || !SLUG_REGEX.test(slug)) {
      return res.status(400).json({
        error: "Invalid slug. Use only lowercase letters, digits, and hyphens.",
      });
    }

    if (RESERVED_SLUGS.has(slug)) {
      return res.status(400).json({ error: `Slug '${slug}' is reserved.` });
    }

    const exists = await Tenant.findOne({ slug });
    if (exists) {
      return res.status(409).json({ error: "Slug already taken" });
    }

    const dbName = `crm_${slug}`;
    const tenant = await Tenant.create({
      name,
      slug,
      dbName,
      adminEmail: adminEmail.toLowerCase(),
      adminName,
      createdBy: req.superAdmin.id,
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



      const hashedPassword = await userService.hashPassword(plainPassword);

      await User.create({
        firstName:   adminName.split(" ")[0],
        lastName:    adminName.split(" ").slice(1).join(" ") || adminName.split(" ")[0],
        email:       adminEmail.toLowerCase(),
        password:    hashedPassword,
        role:        adminRole._id,
        dateOfBirth: new Date("1990-01-01"),
        status:      "Active",
      });

      await EmailTemplate.insertMany(defaultEmailTemplates);
    } catch (setupErr) {
      // Setup failed — remove the orphaned tenant record so the slug can be retried
      await Tenant.findByIdAndDelete(tenant._id);
      console.error("Tenant setup failed, rolled back tenant record:", setupErr.message);
      return res.status(500).json({ error: "Tenant setup failed: " + setupErr.message });
    }

    const loginUrl = `${process.env.FRONTEND_URL}/${slug}/login`;

    // Send welcome email using dynamic template from SuperAdminSettings
    sendWelcomeEmail({
      to: adminEmail,
      vars: { adminName, email: adminEmail, password: plainPassword, loginUrl },
    }).catch(err => console.error("Welcome email failed:", err.message));

    res.status(201).json({
      success: true,
      tenant,
      loginUrl,
    });
  } catch (err) {
    console.error("Create tenant error:", err);
    if (err.code === 11000) {
      return res.status(409).json({ error: "Slug or dbName already exists" });
    }
    res.status(500).json({ error: err.message || "Server error" });
  }
};

export const listTenants = async (req, res) => {
  try {
    const tenants = await Tenant.find().populate("plan_id").sort({ createdAt: -1 });
    res.json({ tenants });
  } catch (err) {
    console.error("List tenants error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const toggleTenant = async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) return res.status(404).json({ error: "Tenant not found" });

    tenant.isActive = !tenant.isActive;
    await tenant.save();

    res.json({ success: true, isActive: tenant.isActive, tenant });
  } catch (err) {
    console.error("Toggle tenant error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const deleteTenant = async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) return res.status(404).json({ error: "Tenant not found" });

    // Drop DB
    await dropTenantDB(tenant.dbName);

    // Delete Master Record
    await Tenant.findByIdAndDelete(req.params.id);

    res.json({ success: true, message: "Tenant and database deleted successfully" });
  } catch (err) {
    console.error("Delete tenant error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const getDashboardStats = async (req, res) => {
  try {
    const [totalTenants, activeTenantsCount, recentTenants, tenantsList] = await Promise.all([
      Tenant.countDocuments(),
      Tenant.countDocuments({ isActive: true }),
      Tenant.find().sort({ createdAt: -1 }).limit(5),
      Tenant.find({ isActive: true }).populate("plan_id"),
    ]);

    // 1. Calculate total users across all active tenants
    let totalUsers = 0;
    for (const tenant of tenantsList) {
      try {
        const tenantDB = await getTenantDB(tenant.dbName);
        const { User } = getTenantModels(tenantDB);
        const userCount = await User.countDocuments();
        totalUsers += userCount;
      } catch (dbErr) {
        console.error(`Failed to get user count for tenant ${tenant.slug}:`, dbErr.message);
      }
    }

    // 2. Calculate total revenue (active plan subscriptions + approved upgrades)
    let totalRevenue = 0;

    // Add active subscription plan prices
    for (const tenant of tenantsList) {
      if (tenant.plan_id && tenant.plan_status === "active") {
        if (tenant.plan_id.billing_cycle === "yearly") {
          totalRevenue += tenant.plan_id.price_yearly || 0;
        } else {
          totalRevenue += tenant.plan_id.price_monthly || 0;
        }
      }
    }

    // Add approved upgrade requests final price
    try {
      const approvedUpgrades = await UpgradeRequest.find({ status: "approved" });
      const upgradeRevenue = approvedUpgrades.reduce((sum, req) => sum + (req.final_price || 0), 0);
      totalRevenue += upgradeRevenue;
    } catch (upgradeErr) {
      console.error("Failed to calculate upgrade request revenue:", upgradeErr.message);
    }

    res.json({
      success: true,
      totalTenants,
      activeTenants: activeTenantsCount,
      inactiveTenants: totalTenants - activeTenantsCount,
      totalUsers,
      totalRevenue,
      recentTenants,
    });
  } catch (err) {
    console.error("Dashboard stats error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const impersonateTenant = async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) return res.status(404).json({ error: "Tenant not found" });

    const tenantDB = await getTenantDB(tenant.dbName);
    const { User } = getTenantModels(tenantDB);

    // Find the tenant admin user
    const user = await User.findOne({ email: tenant.adminEmail.toLowerCase() }).populate("role");
    if (!user) {
      return res.status(404).json({ error: "Tenant administrator user not found" });
    }

    // Generate JWT token (signed with tenant SECRET_KEY and tokenVersion)
    const token = jwt.sign(
      {
        id: user._id,
        tokenVersion: user.tokenVersion || 0,
        dbName: tenant.dbName,
        slug: tenant.slug,
        tenantId: tenant._id,
      },
      process.env.SECRET_KEY,
      { expiresIn: "1d" }
    );

    res.json({
      success: true,
      token,
      slug: tenant.slug,
      user: {
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        profileImage: user.profileImage,
        role: user.role,
      }
    });
  } catch (err) {
    console.error("Impersonate tenant error:", err);
    res.status(500).json({ error: "Server error during impersonation" });
  }
};

export const resetTenantDB = async (tenant, plainPassword) => {
  // 1. Drop existing database
  await dropTenantDB(tenant.dbName);

  // 2. Re-create default tables and users
  const tenantDB = await getTenantDB(tenant.dbName);
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

  const hashedPassword = await userService.hashPassword(plainPassword);
  
  await User.create({
    firstName:   tenant.adminName.split(" ")[0],
    lastName:    tenant.adminName.split(" ").slice(1).join(" ") || tenant.adminName.split(" ")[0],
    email:       tenant.adminEmail.toLowerCase(),
    password:    hashedPassword,
    role:        adminRole._id,
    dateOfBirth: new Date("1990-01-01"),
    status:      "Active",
  });

  await EmailTemplate.insertMany(defaultEmailTemplates);
};

export const createUpgradeRequest = async (req, res) => {
  try {
    const { tenantSlug, planId, wantedUsers, loginDays, description, type } = req.body;

    const tenant = await Tenant.findOne({ slug: tenantSlug }).populate("plan_id");
    if (!tenant) return res.status(404).json({ success: false, error: "Tenant not found" });

    const newPlan = await SubscriptionPlan.findById(planId);
    if (!newPlan) return res.status(404).json({ success: false, error: "Subscription plan not found" });

    let proratedDiscount = 0;
    if (type === "mid_cycle" && tenant.plan_end_date && tenant.plan_id) {
      const remainingMs = new Date(tenant.plan_end_date) - new Date();
      const remainingDays = Math.max(0, Math.ceil(remainingMs / (1000 * 60 * 60 * 24)));
      const dailyRate = (tenant.plan_id.price_monthly || 0) / 30;
      proratedDiscount = Number((dailyRate * remainingDays).toFixed(2));
    }

    const basePrice = newPlan.price_monthly || 0;
    const finalPrice = Math.max(0, Number((basePrice - proratedDiscount).toFixed(2)));

    const request = await UpgradeRequest.create({
      tenant_id: tenant._id,
      plan_id: planId,
      wanted_users: Number(wantedUsers),
      login_days: Number(loginDays),
      description: description || "",
      type,
      prorated_discount: proratedDiscount,
      final_price: finalPrice,
    });

    // Real-time update — send full populated request so the list updates instantly
    const populatedRequest = await UpgradeRequest.findById(request._id)
      .populate("tenant_id")
      .populate("plan_id");
    emitToSuperAdmin("new_upgrade_request", populatedRequest);

    // Notify super admin about the upgrade request
    sendUpgradeAlertEmail({
      vars: {
        tenantName: tenant.name,
        tenantEmail: tenant.adminEmail,
        planName: newPlan.plan_name,
      },
    }).catch(err => console.error("Upgrade alert email failed:", err.message));

    res.status(201).json({ success: true, request });
  } catch (err) {
    console.error("Create upgrade request error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

export const getUpgradeRequests = async (req, res) => {
  try {
    const requests = await UpgradeRequest.find({ status: "pending" })
      .populate("tenant_id")
      .populate("plan_id")
      .sort({ createdAt: -1 });

    res.json({ success: true, requests });
  } catch (err) {
    console.error("Get upgrade requests error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

function upgradeEmailHtml({ adminName, planName, wantedUsers, loginDays, password, loginUrl }) {
  return `
<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; background-color: #f4f6fb; padding: 20px;">
  <div style="background-color: #ffffff; padding: 30px; border-radius: 12px; max-width: 550px; margin: 0 auto; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
    <h2 style="color: #008ecc; text-align: center;">Workspace Upgrade Activated</h2>
    <p>Dear <strong>${adminName}</strong>,</p>
    <p>Your tenant workspace has been successfully upgraded to the <strong>${planName}</strong> plan.</p>
    <h4 style="border-bottom: 1px solid #eee; padding-bottom: 5px; color: #333;">New Plan Specifications:</h4>
    <ul>
      <li><strong>User Seats:</strong> ${wantedUsers} Max Active Users</li>
      <li><strong>Validity Days:</strong> ${loginDays} Days</li>
    </ul>
    <div style="background-color: #f0f7ff; border: 1px solid #d0e5ff; padding: 15px; border-radius: 8px; margin: 20px 0;">
      <h5 style="margin: 0 0 10px 0; color: #008ecc;">Plan Upgraded Successfully</h5>
      <p style="margin: 0; font-size: 13px; color: #555;">
        Your plan has been upgraded. All your existing data has been preserved. Here are your new administrator credentials:
      </p>
      <p style="margin: 10px 0 0 0; font-family: monospace; font-size: 15px;">
        <strong>Password:</strong> <span style="background: #fff; padding: 2px 8px; border: 1px dashed #008ecc; font-weight: bold; color: #008ecc;">${password}</span>
      </p>
    </div>
    <div style="text-align: center; margin-top: 25px;">
      <a href="${loginUrl}" target="_blank" style="background-color: #008ecc; color: #ffffff; text-decoration: none; padding: 12px 30px; border-radius: 6px; font-weight: bold; display: inline-block;">Login to CRM Workspace</a>
    </div>
    <p style="font-size: 11px; color: #888; margin-top: 30px; border-top: 1px solid #eee; padding-top: 15px; text-align: center;">
      © ${new Date().getFullYear()} TZI Support. All rights reserved.
    </p>
  </div>
</body>
</html>`;
}

export const approveUpgradeRequest = async (req, res) => {
  try {
    const request = await UpgradeRequest.findById(req.params.id)
      .populate("tenant_id")
      .populate("plan_id");

    if (!request) return res.status(404).json({ success: false, error: "Request not found" });
    if (request.status !== "pending") {
      return res.status(400).json({ success: false, error: "Request has already been processed" });
    }

    const tenant = request.tenant_id;
    const plan = request.plan_id;

    // 1. Generate auto password
    const plainPassword = generatePassword();
    console.log(`[PLAN UPGRADE] Generated password for tenant "${tenant.slug}": ${plainPassword}`);

    // 2. Update admin password and invalidate current token — existing data is preserved
    const tenantDB = await getTenantDB(tenant.dbName);
    const { User } = getTenantModels(tenantDB);
    const adminUser = await User.findOne({ email: tenant.adminEmail.toLowerCase() });
    if (adminUser) {
      adminUser.password = await userService.hashPassword(plainPassword);
      adminUser.tokenVersion = (adminUser.tokenVersion || 0) + 1;
      await adminUser.save();
    }

    // 3. Update Tenant fields
    tenant.plan_id = plan._id;
    tenant.plan_status = "active";
    tenant.plan_start_date = new Date();
    tenant.plan_end_date = new Date(Date.now() + request.login_days * 24 * 60 * 60 * 1000);
    tenant.isDbRefreshed = true;
    await tenant.save();

    // 4. Update request status
    request.status = "approved";
    await request.save();

    // 5. Send Upgrade activation email with generated credentials
    const loginUrl = `${process.env.FRONTEND_URL}/${tenant.slug}/login`;
    sendEmail({
      to: tenant.adminEmail,
      subject: `Your CRM Workspace Plan Has Been Upgraded — New Credentials`,
      html: upgradeEmailHtml({
        adminName: tenant.adminName,
        planName: plan.plan_name,
        wantedUsers: request.wanted_users,
        loginDays: request.login_days,
        password: plainPassword,
        loginUrl,
      }),
    }).catch((emailErr) => console.error("Upgrade activation email failed:", emailErr.message));

    emitToSuperAdmin("upgrade_request_resolved", { id: req.params.id });
    res.json({ success: true, message: "Upgrade request approved successfully." });
  } catch (err) {
    console.error("Approve upgrade request error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

function rejectEmailHtml({ adminName, planName, wantedUsers, loginDays, reason }) {
  return `
<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; background-color: #f4f6fb; padding: 20px;">
  <div style="background-color: #ffffff; padding: 30px; border-radius: 12px; max-width: 550px; margin: 0 auto; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
    <h2 style="color: #d93025; text-align: center;">Upgrade Request Declined</h2>
    <p>Dear <strong>${adminName}</strong>,</p>
    <p>Your request to upgrade your workspace to the <strong>${planName}</strong> plan has been declined.</p>
    
    <div style="background-color: #fce8e6; border: 1px solid #fad2cf; padding: 15px; border-radius: 8px; margin: 20px 0;">
      <h5 style="margin: 0 0 10px 0; color: #c5221f;">Reason for Rejection:</h5>
      <p style="margin: 0; font-size: 14px; color: #202124; line-height: 1.5; white-space: pre-wrap;">${reason || "No reason specified."}</p>
    </div>

    <h4 style="border-bottom: 1px solid #eee; padding-bottom: 5px; color: #333;">Requested Specifications:</h4>
    <ul>
      <li><strong>User Seats:</strong> ${wantedUsers} Max Active Users</li>
      <li><strong>Validity Days:</strong> ${loginDays} Days</li>
    </ul>

    <p style="font-size: 13px; color: #555; line-height: 1.5;">
      If you have any questions or would like to submit another request with adjusted parameters, please log in to your portal or contact support.
    </p>
    
    <p style="font-size: 11px; color: #888; margin-top: 30px; border-top: 1px solid #eee; padding-top: 15px; text-align: center;">
      © ${new Date().getFullYear()} TZI Support. All rights reserved.
    </p>
  </div>
</body>
</html>`;
}

export const rejectUpgradeRequest = async (req, res) => {
  try {
    const { reason } = req.body;
    const request = await UpgradeRequest.findById(req.params.id)
      .populate("tenant_id")
      .populate("plan_id");

    if (!request) return res.status(404).json({ success: false, error: "Request not found" });
    if (request.status !== "pending") {
      return res.status(400).json({ success: false, error: "Request has already been processed" });
    }

    const tenant = request.tenant_id;
    const plan = request.plan_id;

    // Update request status and rejection reason
    request.status = "rejected";
    request.rejection_reason = reason || "";
    await request.save();

    // Send Rejection email
    sendEmail({
      to: tenant.adminEmail,
      subject: `CRM Workspace Upgrade Request Declined`,
      html: rejectEmailHtml({
        adminName: tenant.adminName,
        planName: plan.plan_name,
        wantedUsers: request.wanted_users,
        loginDays: request.login_days,
        reason: reason,
      }),
    }).catch((emailErr) => console.error("Upgrade rejection email failed:", emailErr.message));

    emitToSuperAdmin("upgrade_request_resolved", { id: req.params.id });
    res.json({ success: true, message: "Upgrade request rejected successfully." });
  } catch (err) {
    console.error("Reject upgrade request error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

export const getTenantDetails = async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id).populate("plan_id");
    if (!tenant) return res.status(404).json({ success: false, error: "Tenant not found" });

    // Fetch user count from tenant database
    let activeUsersCount = 0;
    try {
      const tenantDB = await getTenantDB(tenant.dbName);
      const { User } = getTenantModels(tenantDB);
      activeUsersCount = await User.countDocuments();
    } catch (dbErr) {
      console.error(`Failed to read user count for tenant DB ${tenant.dbName}:`, dbErr.message);
    }

    // Fetch plan upgrade history for this tenant
    const history = await UpgradeRequest.find({ tenant_id: tenant._id, status: "approved" })
      .populate("plan_id")
      .sort({ updatedAt: -1 });

    res.json({
      success: true,
      tenant: {
        _id: tenant._id,
        name: tenant.name,
        slug: tenant.slug,
        dbName: tenant.dbName,
        adminEmail: tenant.adminEmail,
        adminName: tenant.adminName,
        isActive: tenant.isActive,
        plan_id: tenant.plan_id,
        plan_status: tenant.plan_status,
        plan_start_date: tenant.plan_start_date,
        plan_end_date: tenant.plan_end_date,
        activeUsersCount,
      },
      history: history || [],
    });
  } catch (err) {
    console.error("Get tenant details error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

export const getTenantBySlugPublic = async (req, res) => {
  try {
    const tenant = await Tenant.findOne({ slug: req.params.slug.toLowerCase() }).populate("plan_id");
    if (!tenant) return res.status(404).json({ success: false, error: "Tenant not found" });

    res.json({
      success: true,
      tenant: {
        _id: tenant._id,
        name: tenant.name,
        slug: tenant.slug,
        plan_id: tenant.plan_id,
        plan_status: tenant.plan_status,
        plan_start_date: tenant.plan_start_date,
        plan_end_date: tenant.plan_end_date,
      }
    });
  } catch (err) {
    console.error("Get public tenant by slug error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

export const getUpgradeHistory = async (req, res) => {
  try {
    const history = await UpgradeRequest.find({ status: { $ne: "pending" } })
      .populate("tenant_id")
      .populate("plan_id")
      .sort({ updatedAt: -1 });

    res.json({ success: true, history });
  } catch (err) {
    console.error("Get upgrade history error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

export const updateTenant = async (req, res) => {
  try {
    const { name, adminName, adminEmail } = req.body;
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) return res.status(404).json({ success: false, error: "Tenant not found" });

    const oldAdminEmail = tenant.adminEmail.toLowerCase();
    const newAdminEmail = adminEmail ? adminEmail.toLowerCase() : oldAdminEmail;

    // 1. Update the master tenant record
    if (name) tenant.name = name;
    if (adminName) tenant.adminName = adminName;
    if (adminEmail) tenant.adminEmail = newAdminEmail;
    await tenant.save();

    // 2. Update the tenant's own database admin user record
    try {
      const tenantDB = await getTenantDB(tenant.dbName);
      const { User } = getTenantModels(tenantDB);
      
      // Find the admin user by the old admin email
      const adminUser = await User.findOne({ email: oldAdminEmail });
      if (adminUser) {
        if (adminName) {
          adminUser.firstName = adminName.split(" ")[0];
          adminUser.lastName = adminName.split(" ").slice(1).join(" ") || adminName.split(" ")[0];
        }
        if (adminEmail) {
          adminUser.email = newAdminEmail;
        }
        await adminUser.save();
      }
    } catch (dbErr) {
      console.error(`Failed to update tenant database user for ${tenant.slug}:`, dbErr.message);
    }

    res.json({ success: true, message: "Tenant updated successfully.", tenant });
  } catch (err) {
    console.error("Update tenant error:", err);
    res.status(500).json({ success: false, error: err.message || "Server error" });
  }
};
