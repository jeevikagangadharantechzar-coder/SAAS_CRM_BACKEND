import cron from "node-cron";
import { sendNotification } from "../services/notificationService.js";
import { getTenantDB } from "../config/tenantDB.js";
import { getTenantModels } from "../models/tenant/index.js";
import Tenant from "../models/master/Tenant.js";
import mongoose from "mongoose";

// Legacy models (for /api/ non-tenant routes)
import DealLegacy         from "../models/deals.model.js";
import LeadLegacy         from "../models/leads.model.js";
import ProposalLegacy     from "../models/proposal.model.js";
import NotificationLegacy from "../models/notification.model.js";
import UserLegacy         from "../models/user.model.js";
import RoleLegacy         from "../models/role.model.js";

let isCronRunning = false;

const checkDbConnection = () => {
  if (mongoose.connection.readyState !== 1) {
    console.log("MongoDB not connected, skipping cron run");
    return false;
  }
  return true;
};

const getAdminUserIds = async (Role, User) => {
  try {
    const adminRole = await Role.findOne({ name: "Admin" }).lean();
    if (!adminRole) return [];
    const admins = await User.find({ role: adminRole._id, status: "Active" }).select("_id").lean();
    return admins.map((u) => String(u._id));
  } catch (err) {
    console.error("Failed to fetch admin users:", err.message);
    return [];
  }
};

const runForModels = async ({ Deal, Lead, Proposal, Notification, User, Role }, tenantDB = null, label = "legacy") => {
  const now = new Date();
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);

  // Purge expired notifications
  const expiredResult = await Notification.deleteMany({ expiresAt: { $lte: now } });
  if (expiredResult.deletedCount > 0) console.log(`[${label}] Deleted ${expiredResult.deletedCount} expired notification(s)`);

  const adminIds = await getAdminUserIds(Role, User);

  // ── Deals ────────────────────────────────────────────────────────────────
  try {
    const dueDeals = await Deal.find({
      followUpDate: { $lte: now },
      stage: { $nin: ["Closed Won", "Closed Lost"] },
      $or: [{ lastReminderAt: { $exists: false } }, { lastReminderAt: null }, { lastReminderAt: { $lt: todayStart } }],
    }).populate("assignedTo", "_id firstName lastName email profileImage");

    for (const deal of dueDeals) {
      try {
        if (!deal.assignedTo?._id) continue;
        await sendNotification(deal.assignedTo._id, `Deal follow-up due: ${deal.dealName || "Unnamed"}`, "followup",
          { dealId: deal._id, dealName: deal.dealName, profileImage: deal.assignedTo?.profileImage },
          { title: "Deal Follow-up", followUpDate: deal.followUpDate }, tenantDB);

        for (const adminId of adminIds) {
          if (String(adminId) !== String(deal.assignedTo._id))
            await sendNotification(adminId, `Deal follow-up due: ${deal.dealName || "Unnamed"}`, "followup",
              { dealId: deal._id, dealName: deal.dealName, profileImage: deal.assignedTo?.profileImage },
              { title: "Deal Follow-up", followUpDate: deal.followUpDate }, tenantDB);
        }
        deal.lastReminderAt = new Date();
        await deal.save();
      } catch (e) { console.error(`[${label}] Error processing deal ${deal._id}:`, e.message); }
    }
  } catch (e) { console.error(`[${label}] Error in deals section:`, e.message); }

  // ── Leads ────────────────────────────────────────────────────────────────
  try {
    const dueLeads = await Lead.find({
      followUpDate: { $lte: now },
      status: { $nin: ["Converted", "Junk"] },
      $or: [{ lastReminderAt: { $exists: false } }, { lastReminderAt: null }, { lastReminderAt: { $lt: todayStart } }],
    }).populate("assignTo", "_id firstName lastName email profileImage");

    for (const lead of dueLeads) {
      try {
        if (!lead.assignTo?._id) continue;
        await sendNotification(lead.assignTo._id, `Lead follow-up due: ${lead.leadName || "Unnamed"}`, "followup",
          { leadId: lead._id, leadName: lead.leadName, profileImage: lead.assignTo?.profileImage },
          { title: "Lead Follow-up", followUpDate: lead.followUpDate }, tenantDB);
        lead.lastReminderAt = new Date();
        await lead.save();
      } catch (e) { console.error(`[${label}] Error processing lead ${lead._id}:`, e.message); }
    }
  } catch (e) { console.error(`[${label}] Error in leads section:`, e.message); }

  // ── Proposals ────────────────────────────────────────────────────────────
  try {
    const dueProposals = await Proposal.find({
      followUpDate: { $lte: now },
      status: { $nin: ["success", "rejection"] },
      $or: [{ lastReminderAt: { $exists: false } }, { lastReminderAt: null }, { lastReminderAt: { $lt: todayStart } }],
    }).populate({ path: "deal", populate: { path: "assignedTo", select: "_id firstName lastName email profileImage" } });

    for (const proposal of dueProposals) {
      try {
        const assignedTo = proposal.deal?.assignedTo;
        if (!assignedTo?._id) continue;
        await sendNotification(assignedTo._id, `Proposal follow-up due: ${proposal.title || "Unnamed"}`, "followup",
          { proposalId: proposal._id, proposalTitle: proposal.title, dealId: proposal.deal?._id, profileImage: assignedTo?.profileImage },
          { title: "Proposal Follow-up", followUpDate: proposal.followUpDate }, tenantDB);

        for (const adminId of adminIds) {
          if (String(adminId) !== String(assignedTo._id))
            await sendNotification(adminId, `Proposal follow-up due: ${proposal.title || "Unnamed"}`, "followup",
              { proposalId: proposal._id, proposalTitle: proposal.title, dealId: proposal.deal?._id, profileImage: assignedTo?.profileImage },
              { title: "Proposal Follow-up", followUpDate: proposal.followUpDate }, tenantDB);
        }
        proposal.lastReminderAt = new Date();
        await proposal.save();
      } catch (e) { console.error(`[${label}] Error processing proposal ${proposal._id}:`, e.message); }
    }
  } catch (e) { console.error(`[${label}] Error in proposals section:`, e.message); }
};

const runNotificationCron = async () => {
  if (isCronRunning) { console.log("Cron already running, skipping"); return; }
  if (!checkDbConnection()) return;

  isCronRunning = true;
  const startTime = Date.now();
  try {
    console.log(`Notification Cron Started: ${new Date().toISOString()}`);

    // 1. Legacy connection
    await runForModels({ Deal: DealLegacy, Lead: LeadLegacy, Proposal: ProposalLegacy, Notification: NotificationLegacy, User: UserLegacy, Role: RoleLegacy }, null, "legacy");

    // 2. Per-tenant
    let tenants = [];
    try { tenants = await Tenant.find({ isActive: true }).lean(); }
    catch (e) { console.warn("NotificationCron: could not load tenants:", e.message); }

    for (const tenant of tenants) {
      try {
        const tenantDB = await getTenantDB(tenant.dbName);
        const models   = getTenantModels(tenantDB);
        await runForModels(models, tenantDB, tenant.slug);
      } catch (e) { console.error(`NotificationCron error for tenant ${tenant.slug}:`, e.message); }
    }

    console.log(`Notification Cron Completed in ${Date.now() - startTime}ms`);
  } catch (error) {
    console.error("FATAL CRON ERROR:", error);
  } finally {
    isCronRunning = false;
  }
};

let cronTask = null;

export const startCron = () => {
  if (cronTask) { cronTask.stop(); }
  cronTask = cron.schedule("*/1 * * * *", async () => {
    try { await runNotificationCron(); }
    catch (err) { console.error("Cron execution error:", err); }
  });
  console.log(`Notification Cron started: ${new Date().toISOString()}`);
};

startCron();

process.on("SIGINT",  () => { if (cronTask) cronTask.stop(); process.exit(0); });
process.on("SIGTERM", () => { if (cronTask) cronTask.stop(); process.exit(0); });

process.on("unhandledRejection", (reason, promise) => { console.error("Unhandled Rejection at:", promise, "reason:", reason); });
process.on("uncaughtException",  (error)           => { console.error("Uncaught Exception:", error); });

export { runNotificationCron };
