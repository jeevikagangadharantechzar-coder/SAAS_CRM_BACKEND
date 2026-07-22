import cron from "node-cron";
import moment from "moment";
import { sendNotification } from "../services/notificationService.js";
import { getTenantDB } from "../config/tenantDB.js";
import { getTenantModels } from "../models/tenant/index.js";
import Tenant from "../models/master/Tenant.js";
import { logActivity } from "../services/tenantActivityLog.service.js";

// Legacy models
import DealLegacy from "../models/deals.model.js";
import UserLegacy from "../models/user.model.js";
import RoleLegacy from "../models/role.model.js";

const SHOULD_REMIND_EVERY_MINUTES = 1440;

const getAdminUserIds = async (User, Role) => {
  const adminRole = await Role.findOne({ name: "Admin" });
  if (!adminRole) return [];
  const admins = await User.find({ role: adminRole._id }, "_id");
  return admins.map((a) => a._id.toString());
};

const runDealFollowUpForModels = async ({ Deal, User, Role }, tenantDB = null, label = "legacy") => {
  const nowUtc = moment.utc();
  console.log(`Deal Follow-up Cron [${label}] Running:`, nowUtc.format("YYYY-MM-DD HH:mm:ss"));

  const dueDeals = await Deal.find({
    followUpDate: { $lte: nowUtc.toDate() },
    stage: { $nin: ["Closed Won","Closed Lost"] },
    $or: [
      { lastReminderAt: { $exists: false } },
      { lastReminderAt: null },
      { lastReminderAt: { $lte: nowUtc.clone().subtract(1, "day").toDate() } },
    ],
  }).populate("assignedTo","firstName lastName email _id profileImage");

  if (!dueDeals.length) { console.log(`[${label}] No due deals found`); return; }
  console.log(`[${label}] Found ${dueDeals.length} due deals`);

  const admins = await getAdminUserIds(User, Role);

  for (const deal of dueDeals) {
    const assignUserId = deal.assignedTo?._id?.toString();
    const salesmanName = deal.assignedTo ? `${deal.assignedTo.firstName||""} ${deal.assignedTo.lastName||""}`.trim() : "Unassigned";

    if (assignUserId)
      await sendNotification(assignUserId, `Follow-up due for deal: ${deal.dealName}`, "followup",
        { dealId: deal._id.toString(), dealName: deal.dealName, salesmanName, profileImage: deal.assignedTo?.profileImage }, {}, tenantDB);

    for (const adminId of admins)
      await sendNotification(adminId, `Deal follow-up due: ${deal.dealName} (Assigned to: ${salesmanName})`, "admin",
        { dealId: deal._id.toString(), dealName: deal.dealName, salesmanName, salesmanId: assignUserId }, {}, tenantDB);

    deal.lastReminderAt = new Date();
    await deal.save();
    console.log(`[${label}] Updated lastReminderAt for deal: ${deal.dealName}`);
  }
};

export default {
  async getAdminUserIds() {
    return getAdminUserIds(UserLegacy, RoleLegacy);
  },

  startDealFollowUpCron() {
    cron.schedule("* * * * *", async () => {
      try {
        // 1. Legacy connection
        await runDealFollowUpForModels({ Deal: DealLegacy, User: UserLegacy, Role: RoleLegacy }, null, "legacy");

        // 2. Per-tenant
        let tenants = [];
        try { tenants = await Tenant.find({ isActive: true }).lean(); }
        catch (e) { console.warn("DealFollowUpCron: could not load tenants:", e.message); }

        for (const tenant of tenants) {
          let tenantDB;
          try {
            tenantDB = await getTenantDB(tenant.dbName);
            const models = getTenantModels(tenantDB);
            await runDealFollowUpForModels(models, tenantDB, tenant.slug);
          } catch (e) {
            console.error(`DealFollowUpCron error for tenant ${tenant.slug}:`, e.message);
            if (tenantDB) {
              logActivity(tenantDB, {
                module: "Deals",
                action: "Deal Follow-up Reminder Cron",
                status: "Failed",
                errorMessage: e.message,
              });
            }
          }
        }
      } catch (error) {
        console.error("Deal follow-up cron error:", error);
      }
    });
  },
};
