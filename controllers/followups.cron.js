import cron from "node-cron";
import { sendNotification } from "../services/notificationService.js";
import { getTenantDB } from "../config/tenantDB.js";
import { getTenantModels } from "../models/tenant/index.js";
import Tenant from "../models/master/Tenant.js";
import { logActivity } from "../services/tenantActivityLog.service.js";

// Legacy models (for /api/ non-tenant routes)
import LeadLegacy         from "../models/leads.model.js";
import UserLegacy         from "../models/user.model.js";
import RoleLegacy         from "../models/role.model.js";
import NotificationLegacy from "../models/notification.model.js";

const COOLDOWN_MS = 24 * 60 * 60 * 1000;

const getAdminUserIds = async (User, Role) => {
  const adminRole = await Role.findOne({ name: "Admin" });
  if (!adminRole) return [];
  const admins = await User.find({ role: adminRole._id }, "_id");
  return admins.map((a) => a._id.toString());
};

const notificationExists = async (userId, leadId, Notification) => {
  const cutoff = new Date(Date.now() - COOLDOWN_MS);
  const existing = await Notification.findOne({ userId, type: "followup", "meta.leadId": leadId, createdAt: { $gte: cutoff } });
  return !!existing;
};

const runFollowUpForModels = async ({ Lead, User, Role, Notification }, tenantDB = null, label = "legacy") => {
  const now          = new Date();
  const bufferNow    = new Date(now.getTime() + 5 * 60 * 1000);
  const cooldownCutoff = new Date(now.getTime() - COOLDOWN_MS);

  console.log(`FollowUp Cron [${label}]:`, now.toISOString());

  const dueLeads = await Lead.find({
    followUpDate: { $lte: bufferNow },
    status: { $in: ["Hot","Warm","Cold"] },
    $or: [{ lastReminderAt: { $exists: false } }, { lastReminderAt: null }, { lastReminderAt: { $lt: cooldownCutoff } }],
  }).populate("assignTo", "firstName lastName email _id");

  if (!dueLeads.length) return;

  const admins = await getAdminUserIds(User, Role);

  for (const lead of dueLeads) {
    const assignUserId = lead.assignTo?._id?.toString();
    const leadId       = lead._id.toString();
    const leadName     = lead.leadName || "Unnamed Lead";

    if (assignUserId) {
      const alreadySent = await notificationExists(assignUserId, leadId, Notification);
      if (!alreadySent)
        await sendNotification(assignUserId, `You missed a follow-up for Lead: ${leadName}`, "followup", { leadId }, {}, tenantDB);
    }

    for (const adminId of admins) {
      const alreadySent = await notificationExists(adminId, leadId, Notification);
      if (!alreadySent)
        await sendNotification(adminId, `Salesman ${lead.assignTo?.firstName||"Unknown"} missed follow-up for Lead: ${leadName}`, "followup",
          { leadId, salesman: lead.assignTo?.firstName||"Unknown", salesmanId: assignUserId }, {}, tenantDB);
    }

    await Lead.updateOne({ _id: lead._id }, { $set: { lastReminderAt: now } });
    console.log(`[${label}] Stamped lastReminderAt for "${leadName}"`);
  }
};

export function startFollowUpCron() {
  cron.schedule("* * * * *", async () => {
    try {
      // 1. Legacy connection
      await runFollowUpForModels(
        { Lead: LeadLegacy, User: UserLegacy, Role: RoleLegacy, Notification: NotificationLegacy },
        null, "legacy"
      );

      // 2. Per-tenant
      let tenants = [];
      try { tenants = await Tenant.find({ isActive: true }).lean(); }
      catch (e) { console.warn("FollowUpCron: could not load tenants:", e.message); }

      for (const tenant of tenants) {
        let tenantDB;
        try {
          tenantDB = await getTenantDB(tenant.dbName);
          const models = getTenantModels(tenantDB);
          await runFollowUpForModels(models, tenantDB, tenant.slug);
        } catch (e) {
          console.error(`FollowUpCron error for tenant ${tenant.slug}:`, e.message);
          if (tenantDB) {
            logActivity(tenantDB, {
              module: "Leads",
              action: "Lead Follow-up Reminder Cron",
              status: "Failed",
              errorMessage: e.message,
            });
          }
        }
      }
    } catch (err) {
      console.error("FollowUp cron error:", err.message);
    }
  });

  // Purge expired notifications every hour
  cron.schedule("0 * * * *", async () => {
    try {
      const result = await NotificationLegacy.deleteMany({ expiresAt: { $lte: new Date() } });
      console.log("Expired notifications deleted (legacy):", result.deletedCount);

      let tenants = [];
      try { tenants = await Tenant.find({ isActive: true }).lean(); } catch (_) {}
      for (const tenant of tenants) {
        try {
          const tenantDB = await getTenantDB(tenant.dbName);
          const { Notification } = getTenantModels(tenantDB);
          const r = await Notification.deleteMany({ expiresAt: { $lte: new Date() } });
          if (r.deletedCount > 0) console.log(`Expired notifications deleted [${tenant.slug}]:`, r.deletedCount);
        } catch (e) { console.error(`Notification cleanup error for tenant ${tenant.slug}:`, e.message); }
      }
    } catch (err) {
      console.error("Notification cleanup error:", err.message);
    }
  });
}
