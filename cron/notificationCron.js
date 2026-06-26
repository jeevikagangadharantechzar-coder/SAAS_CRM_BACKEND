import cron from "node-cron";
import { sendNotification } from "../services/notificationService.js";
import { notifyUser } from "../realtime/socket.js";
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

// ── Target deadline reminder + auto-expire ────────────────────────────────────
const runTargetDeadlineCron = async () => {
  let tenants = [];
  try { tenants = await Tenant.find({ isActive: true }).lean(); } catch (_) {}

  const processTargets = async (models, tenantDB, label) => {
    if (!models.Target || !models.Lead || !models.Deal || !models.Notification || !models.User || !models.Role) return;
    const { Target, Lead, Deal, Notification, User, Role } = models;
    const now   = new Date();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
    const tomorrowEnd = new Date(tomorrow); tomorrowEnd.setHours(23, 59, 59, 999);

    const adminRole = await Role.findOne({ name: "Admin" }).lean();
    const adminIds  = adminRole ? (await User.find({ role: adminRole._id, status: "Active" }).select("_id").lean()).map(u => String(u._id)) : [];

    // 1. Reminder: endDate = tomorrow
    const tomorrowTargets = await Target.find({
      endDate: { $gte: tomorrow, $lte: tomorrowEnd },
      reminderSentAt: null,
    }).populate("salesPerson", "firstName lastName _id").populate("linkedLeads", "leadName").populate("linkedDeals", "dealName dealTitle").lean();

    for (const t of tomorrowTargets) {
      if (!t.salesPerson) continue;
      const leadNames = (t.linkedLeads || []).map(l => l.leadName).filter(Boolean).join(", ");
      const dealNames = (t.linkedDeals || []).map(d => d.dealName || d.dealTitle).filter(Boolean).join(", ");
      const itemsSuffix = [leadNames && `Leads: ${leadNames}`, dealNames && `Deals: ${dealNames}`].filter(Boolean).join(" | ");
      const salesName = `${t.salesPerson.firstName} ${t.salesPerson.lastName}`;

      // Notify sales person
      await sendNotification(t.salesPerson._id,
        `⏰ Reminder: Tomorrow is the last day for your target! ${itemsSuffix ? `(${itemsSuffix})` : ""} Complete them before the deadline!`,
        "target_reminder", { targetId: String(t._id), salesName }, {}, tenantDB);
      notifyUser(String(t.salesPerson._id), "target_reminder", { targetId: String(t._id), message: `Tomorrow is the last day for your target! Hurry up and complete: ${itemsSuffix}` });

      // Notify admins
      for (const adminId of adminIds) {
        await sendNotification(adminId,
          `⏰ Reminder: Tomorrow is the last day for ${salesName}'s target. ${itemsSuffix ? `(${itemsSuffix})` : ""}`,
          "target_reminder", { targetId: String(t._id), salesName }, {}, tenantDB);
      }

      await Target.findByIdAndUpdate(t._id, { reminderSentAt: new Date() });
    }

    // 2. Due today notification
    const todayEnd = new Date(today); todayEnd.setHours(23, 59, 59, 999);
    const dueTodayTargets = await Target.find({
      endDate: { $gte: today, $lte: todayEnd },
      dueTodaySentAt: null,
    }).populate("salesPerson", "firstName lastName _id").populate("linkedLeads", "leadName").populate("linkedDeals", "dealName dealTitle").lean();

    for (const t of dueTodayTargets) {
      if (!t.salesPerson) continue;
      const leadNames = (t.linkedLeads || []).map(l => l.leadName).filter(Boolean).join(", ");
      const dealNames = (t.linkedDeals || []).map(d => d.dealName || d.dealTitle).filter(Boolean).join(", ");
      const itemsSuffix = [leadNames && `Leads: ${leadNames}`, dealNames && `Deals: ${dealNames}`].filter(Boolean).join(" | ");
      const salesName = `${t.salesPerson.firstName} ${t.salesPerson.lastName}`;

      // Notify sales person
      await sendNotification(t.salesPerson._id,
        `🚨 Today is the LAST day for your target! ${itemsSuffix ? `(${itemsSuffix})` : ""} You must complete them today or they will be expired!`,
        "target_due_today", { targetId: String(t._id), salesName }, {}, tenantDB);
      notifyUser(String(t.salesPerson._id), "target_due_today", { targetId: String(t._id), message: `Today is the LAST day! Complete: ${itemsSuffix}` });

      // Notify admins
      for (const adminId of adminIds) {
        await sendNotification(adminId,
          `🚨 Today is the last day for ${salesName}'s target. ${itemsSuffix ? `(${itemsSuffix})` : ""}`,
          "target_due_today", { targetId: String(t._id), salesName }, {}, tenantDB);
      }

      await Target.findByIdAndUpdate(t._id, { dueTodaySentAt: new Date() });
    }

    // 3. Auto-expire: endDate < today (past deadline) — delete incomplete leads/deals
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    const expiredTargets = await Target.find({
      endDate: { $lt: today },
      expiredAt: null,
    }).populate("salesPerson", "firstName lastName _id").lean();

    for (const t of expiredTargets) {
      if (!t.salesPerson) continue;
      const rawLeadIds = (t.linkedLeads || []);
      const rawDealIds = (t.linkedDeals || []);

      // Find incomplete leads (still exist = not converted) and delete them
      const incompleteLeads = await Lead.find({ _id: { $in: rawLeadIds } }).select("_id leadName").lean();
      const incompleteDealDocs = await Deal.find({ _id: { $in: rawDealIds }, stage: { $nin: ["Closed Won"] } }).select("_id dealName").lean();

      const deletedLeadNames = incompleteLeads.map(l => l.leadName);
      const deletedDealNames = incompleteDealDocs.map(d => d.dealName);

      if (incompleteLeads.length > 0) await Lead.deleteMany({ _id: { $in: incompleteLeads.map(l => l._id) } });
      if (incompleteDealDocs.length > 0) await Deal.deleteMany({ _id: { $in: incompleteDealDocs.map(d => d._id) } });

      const allDeleted = [...deletedLeadNames, ...deletedDealNames].join(", ");
      const salesName = `${t.salesPerson.firstName} ${t.salesPerson.lastName}`;

      if (allDeleted) {
        // Notify sales person
        await sendNotification(t.salesPerson._id,
          `❌ Your target has expired! The following incomplete items have been removed: ${allDeleted}. Please discuss with your admin.`,
          "target_expired", { targetId: String(t._id) }, {}, tenantDB);
        notifyUser(String(t.salesPerson._id), "target_expired", { targetId: String(t._id), removed: allDeleted });

        // Notify admins
        for (const adminId of adminIds) {
          await sendNotification(adminId,
            `❌ ${salesName}'s target expired. Removed incomplete items: ${allDeleted}.`,
            "target_expired", { targetId: String(t._id), salesName }, {}, tenantDB);
        }
      }

      await Target.findByIdAndUpdate(t._id, { expiredAt: new Date() });
    }
  };

  // Legacy
  try {
    const legacyModels = {
      Target: (await import("../models/schemas/targetSchema.js")).default,
      Lead: (await import("../models/leads.model.js")).default,
      Deal: (await import("../models/deals.model.js")).default,
      Notification: (await import("../models/notification.model.js")).default,
      User: (await import("../models/user.model.js")).default,
      Role: (await import("../models/role.model.js")).default,
    };
    await processTargets(legacyModels, null, "legacy");
  } catch (e) { console.error("Target cron legacy error:", e.message); }

  for (const tenant of tenants) {
    try {
      const tenantDB = await getTenantDB(tenant.dbName);
      const models = getTenantModels(tenantDB);
      await processTargets(models, tenantDB, tenant.slug);
    } catch (e) { console.error(`Target cron error for tenant ${tenant.slug}:`, e.message); }
  }
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

let targetCronTask = null;

export const startCron = () => {
  if (cronTask) { cronTask.stop(); }
  cronTask = cron.schedule("*/1 * * * *", async () => {
    try { await runNotificationCron(); }
    catch (err) { console.error("Cron execution error:", err); }
  });

  // Target deadline cron — runs daily at 8:00 AM
  if (targetCronTask) { targetCronTask.stop(); }
  targetCronTask = cron.schedule("0 8 * * *", async () => {
    try { await runTargetDeadlineCron(); }
    catch (err) { console.error("Target deadline cron error:", err); }
  });

  console.log(`Notification Cron started: ${new Date().toISOString()}`);
};

startCron();

process.on("SIGINT",  () => { if (cronTask) cronTask.stop(); process.exit(0); });
process.on("SIGTERM", () => { if (cronTask) cronTask.stop(); process.exit(0); });

process.on("unhandledRejection", (reason, promise) => { console.error("Unhandled Rejection at:", promise, "reason:", reason); });
process.on("uncaughtException",  (error)           => { console.error("Uncaught Exception:", error); });

export { runNotificationCron };
