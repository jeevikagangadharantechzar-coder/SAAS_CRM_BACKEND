// Dedicated cron for Target Management deadlines — reminders, due-today
// warnings, and auto-expiry — kept separate from the generic follow-up cron
// in notificationCron.js.
import cron from "node-cron";
import { sendNotification } from "../services/notificationService.js";
import { notifyTargetUser } from "../realtime/targetSocket.js";
import { getTenantDB } from "../config/tenantDB.js";
import { getTenantModels } from "../models/tenant/index.js";
import Tenant from "../models/master/Tenant.js";

const buildLeadLine = (l) => `• Lead "${l.leadName}" — Status: ${l.status || "Cold"}`;
const buildDealLine = (d) => `• Deal "${d.dealName || d.dealTitle}" — Stage: ${d.stage || "Qualification"}`;

const getAdminIds = async (User, Role) => {
  const adminRole = await Role.findOne({ name: "Admin" }).lean();
  if (!adminRole) return [];
  const admins = await User.find({ role: adminRole._id, status: "Active" }).select("_id").lean();
  return admins.map((u) => String(u._id));
};

const journeyBlockFor = (t) =>
  [
    (t.linkedLeads || []).map(buildLeadLine).join("\n"),
    (t.linkedDeals || []).map(buildDealLine).join("\n"),
  ].filter(Boolean).join("\n") || "No leads or deals linked yet.";

// endDate is stored as UTC-midnight of the intended calendar day (Mongoose casts
// date-only strings that way). Anchor "today"/"tomorrow" windows in UTC-day space
// too, so the day boundaries never shift depending on the server's local timezone.
const utcDayStart = (daysFromNow = 0) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysFromNow));
};
const utcDayEnd = (dayStart) => new Date(dayStart.getTime() + 24 * 60 * 60 * 1000 - 1);

// Still-incomplete linked items — Leads not yet Converted, Deals not yet Closed Won.
const getIncompleteItems = (t) => ({
  incompleteLeads: (t.linkedLeads || []).filter((l) => l.status !== "Converted"),
  incompleteDeals: (t.linkedDeals || []).filter((d) => d.stage !== "Closed Won"),
});

// True only when the target has at least one linked lead/deal AND every one of
// them is already Converted/Closed Won — i.e. nothing left to remind about.
const isAlreadyCompleted = (t) => {
  const totalLinked = (t.linkedLeads || []).length + (t.linkedDeals || []).length;
  if (totalLinked === 0) return false;
  const { incompleteLeads, incompleteDeals } = getIncompleteItems(t);
  return incompleteLeads.length === 0 && incompleteDeals.length === 0;
};

// ── Reminder: end date is TOMORROW ────────────────────────────────────────
const sendReminder = async (t, adminIds, tenantDB, Target, tomorrow) => {
  const salesName = `${t.salesPerson.firstName} ${t.salesPerson.lastName}`;
  const journeyBlock = journeyBlockFor(t);

  const salesMsg = `⏰ Tomorrow (${tomorrow.toDateString()}) is the last date for these leads/deals — please hurry and finish them before the deadline!\n\n${journeyBlock}`;
  await sendNotification(t.salesPerson._id, salesMsg, "target_reminder", { targetId: String(t._id), salesName }, { title: "Target Deadline Tomorrow", referenceId: String(t._id) }, tenantDB);
  notifyTargetUser(String(t.salesPerson._id), "target_reminder", { targetId: String(t._id), message: salesMsg });

  const adminMsg = `⏰ Reminder: tomorrow (${tomorrow.toDateString()}) is the last date for ${salesName}'s assigned leads/deals.\n\n${journeyBlock}`;
  for (const adminId of adminIds) {
    await sendNotification(adminId, adminMsg, "target_reminder", { targetId: String(t._id), salesName }, { title: "Target Deadline Tomorrow", referenceId: String(t._id) }, tenantDB);
    notifyTargetUser(String(adminId), "target_reminder", { targetId: String(t._id), message: adminMsg, salesName });
  }

  await Target.findByIdAndUpdate(t._id, { reminderSentAt: new Date() });
};

// ── Due today: end date is TODAY ──────────────────────────────────────────
// Today is the last day, so the still-incomplete items are disabled (read-only,
// no drag/drop, no status/stage edits) right now — not tomorrow when expiry
// runs — until Admin reassigns them (to the same person or someone else).
const sendDueToday = async (t, adminIds, tenantDB, models, today) => {
  const { Target, Lead, Deal } = models;
  const salesName = `${t.salesPerson.firstName} ${t.salesPerson.lastName}`;
  const journeyBlock = journeyBlockFor(t);
  const { incompleteLeads, incompleteDeals } = getIncompleteItems(t);

  if (incompleteLeads.length) await Lead.updateMany({ _id: { $in: incompleteLeads.map((l) => l._id) } }, { isActive: false });
  if (incompleteDeals.length) await Deal.updateMany({ _id: { $in: incompleteDeals.map((d) => d._id) } }, { isActive: false });

  const salesMsg = `🚨 Today (${today.toDateString()}) is the last due date for these leads/deals. Full history so far:\n\n${journeyBlock}\n\nThey are now disabled (read-only, no stage/status changes, no pipeline drag-and-drop) until Admin reassigns them to you or another sales person. Thank you!`;
  await sendNotification(t.salesPerson._id, salesMsg, "target_due_today", { targetId: String(t._id), salesName }, { title: "Today Is the Last Due Date", referenceId: String(t._id) }, tenantDB);
  notifyTargetUser(String(t.salesPerson._id), "target_due_today", { targetId: String(t._id), message: salesMsg });

  const adminMsg = `🚨 Today is the last due date for ${salesName}'s assigned leads/deals. Full tracking history:\n\n${journeyBlock}\n\nThese items have been disabled and are ready for reassignment — click below to reassign to ${salesName} or another sales person.`;
  for (const adminId of adminIds) {
    await sendNotification(adminId, adminMsg, "target_due_today", { targetId: String(t._id), salesName }, { title: "Today Is the Last Due Date", referenceId: String(t._id) }, tenantDB);
    notifyTargetUser(String(adminId), "target_due_today", { targetId: String(t._id), message: adminMsg, salesName });
  }

  await Target.findByIdAndUpdate(t._id, { dueTodaySentAt: new Date() });
};

// ── Auto-expire: end date has PASSED ──────────────────────────────────────
const expireTarget = async (t, adminIds, tenantDB, models) => {
  const { Target, Lead, Deal } = models;
  const salesName = `${t.salesPerson.firstName} ${t.salesPerson.lastName}`;

  const { incompleteLeads, incompleteDeals } = getIncompleteItems(t);

  const removedBlock = [
    incompleteLeads.map(buildLeadLine).join("\n"),
    incompleteDeals.map(buildDealLine).join("\n"),
  ].filter(Boolean).join("\n");

  // Unlink incomplete items from the target (items stay in the system for reassignment)
  await Target.findByIdAndUpdate(t._id, {
    $pullAll: {
      linkedLeads: incompleteLeads.map((l) => l._id),
      linkedDeals: incompleteDeals.map((d) => d._id),
    },
  });

  // Disable the items themselves (not deleted, not unassigned) so they show as
  // read-only/greyed-out to the sales person until admin reassigns them.
  if (incompleteLeads.length) {
    await Lead.updateMany({ _id: { $in: incompleteLeads.map((l) => l._id) } }, { isActive: false });
  }
  if (incompleteDeals.length) {
    await Deal.updateMany({ _id: { $in: incompleteDeals.map((d) => d._id) } }, { isActive: false });
  }

  if (removedBlock) {
    const salesMsg = `❌ Today's due date has passed for these leads/deals — full history:\n\n${removedBlock}\n\nThese leads/deals are now disabled for you (read-only) until Admin reassigns them back to you or to another sales person. Thank you!`;
    await sendNotification(t.salesPerson._id, salesMsg, "target_expired", { targetId: String(t._id), salesName }, { title: "Target Deadline Passed", referenceId: String(t._id) }, tenantDB);
    notifyTargetUser(String(t.salesPerson._id), "target_expired", { targetId: String(t._id), message: salesMsg, removed: removedBlock });

    // Auto-create a pending reason note per incomplete item so it shows up in the
    // existing "Reason Notes" reassignment queue (reuses the existing Reassign button/flow).
    const targetDoc = await Target.findById(t._id);
    if (targetDoc) {
      const alreadyPending = new Set(
        targetDoc.reasonNotes.filter((n) => n.status === "pending").map((n) => String(n.itemId))
      );

      for (const l of incompleteLeads) {
        if (alreadyPending.has(String(l._id))) continue;
        const full = await Lead.findById(l._id).select("companyName phoneNumber email status").lean();
        targetDoc.reasonNotes.push({
          itemType: "lead",
          itemId: l._id,
          itemName: l.leadName,
          note: `Target deadline passed on ${new Date(t.endDate).toDateString()} — automatically removed. Please reassign.`,
          addedBy: t.salesPerson._id,
          status: "pending",
          companyName: full?.companyName || "",
          phoneNumber: full?.phoneNumber || "",
          email: full?.email || "",
          stageOrStatus: full?.status || "",
        });
      }
      for (const d of incompleteDeals) {
        if (alreadyPending.has(String(d._id))) continue;
        const full = await Deal.findById(d._id).select("companyName phoneNumber email value currency stage").lean();
        targetDoc.reasonNotes.push({
          itemType: "deal",
          itemId: d._id,
          itemName: d.dealName || d.dealTitle,
          note: `Target deadline passed on ${new Date(t.endDate).toDateString()} — automatically removed. Please reassign.`,
          addedBy: t.salesPerson._id,
          status: "pending",
          companyName: full?.companyName || "",
          phoneNumber: full?.phoneNumber || "",
          email: full?.email || "",
          value: full?.value ? String(full.value) : "",
          currency: full?.currency || "",
          stageOrStatus: full?.stage || "",
        });
      }
      await targetDoc.save();
    }

    const adminMsg = `❌ ${salesName}'s target deadline has passed. Full tracking history:\n\n${removedBlock}\n\nThese items are ready for reassignment — click below to reassign to ${salesName} or another sales person.`;
    for (const adminId of adminIds) {
      await sendNotification(adminId, adminMsg, "target_expired", { targetId: String(t._id), salesName, needsReassign: true }, { title: "Target Expired — Reassign Needed", referenceId: String(t._id) }, tenantDB);
      notifyTargetUser(String(adminId), "target_expired", { targetId: String(t._id), salesName, removed: removedBlock });
      notifyTargetUser(String(adminId), "reason_note_received", { targetId: String(t._id), salesName, autoExpired: true });
    }
  }

  await Target.findByIdAndUpdate(t._id, { expiredAt: new Date() });
};

const processTargets = async (models, tenantDB) => {
  if (!models.Target || !models.Lead || !models.Deal || !models.Notification || !models.User || !models.Role) return;
  const { Target, User, Role } = models;

  const today = utcDayStart(0);
  const todayEnd = utcDayEnd(today);
  const tomorrow = utcDayStart(1);
  const tomorrowEnd = utcDayEnd(tomorrow);

  const adminIds = await getAdminIds(User, Role);

  const tomorrowTargets = await Target.find({
    endDate: { $gte: tomorrow, $lte: tomorrowEnd },
    reminderSentAt: null,
  }).populate("salesPerson", "firstName lastName _id")
    .populate("linkedLeads", "leadName status")
    .populate("linkedDeals", "dealName dealTitle stage")
    .lean();

  for (const t of tomorrowTargets) {
    try {
      if (!t.salesPerson) continue;
      if (isAlreadyCompleted(t)) {
        await Target.findByIdAndUpdate(t._id, { reminderSentAt: new Date() });
        continue;
      }
      await sendReminder(t, adminIds, tenantDB, Target, tomorrow);
    } catch (e) {
      console.error(`Target reminder error for target ${t._id}:`, e.message);
    }
  }

  const dueTodayTargets = await Target.find({
    endDate: { $gte: today, $lte: todayEnd },
    dueTodaySentAt: null,
  }).populate("salesPerson", "firstName lastName _id")
    .populate("linkedLeads", "leadName status")
    .populate("linkedDeals", "dealName dealTitle stage")
    .lean();

  for (const t of dueTodayTargets) {
    try {
      if (!t.salesPerson) continue;
      if (isAlreadyCompleted(t)) {
        await Target.findByIdAndUpdate(t._id, { dueTodaySentAt: new Date() });
        continue;
      }
      await sendDueToday(t, adminIds, tenantDB, models, today);
    } catch (e) {
      console.error(`Target due-today error for target ${t._id}:`, e.message);
    }
  }

  const expiredTargets = await Target.find({
    endDate: { $lt: today },
    expiredAt: null,
  }).populate("salesPerson", "firstName lastName _id")
    .populate("linkedLeads", "leadName status")
    .populate("linkedDeals", "dealName dealTitle stage")
    .lean();

  for (const t of expiredTargets) {
    try {
      if (!t.salesPerson) continue;
      await expireTarget(t, adminIds, tenantDB, models);
    } catch (e) {
      console.error(`Target expiry error for target ${t._id}:`, e.message);
    }
  }
};

export const runTargetDeadlineCron = async () => {
  let tenants = [];
  try {
    tenants = await Tenant.find({ isActive: true }).lean();
  } catch (e) {
    console.warn("TargetCron: could not load tenants:", e.message);
  }

  for (const tenant of tenants) {
    try {
      const tenantDB = await getTenantDB(tenant.dbName);
      const models = getTenantModels(tenantDB);
      await processTargets(models, tenantDB);
    } catch (e) {
      console.error(`Target cron error for tenant ${tenant.slug}:`, e.message);
    }
  }
};

// On-demand check for a single, just-created/updated target — lets a reminder or
// due-today notification fire immediately instead of waiting for the next periodic tick.
export const checkTargetDeadlineNow = async (targetId, tenantDB) => {
  try {
    const models = getTenantModels(tenantDB);
    const { Target, User, Role } = models;
    if (!Target || !User || !Role) return;

    const t = await Target.findById(targetId)
      .populate("salesPerson", "firstName lastName _id")
      .populate("linkedLeads", "leadName status")
      .populate("linkedDeals", "dealName dealTitle stage")
      .lean();
    if (!t || !t.salesPerson) return;

    const today = utcDayStart(0);
    const todayEnd = utcDayEnd(today);
    const tomorrow = utcDayStart(1);
    const tomorrowEnd = utcDayEnd(tomorrow);
    const endDate = new Date(t.endDate);

    const adminIds = await getAdminIds(User, Role);

    if (!t.reminderSentAt && endDate >= tomorrow && endDate <= tomorrowEnd) {
      if (isAlreadyCompleted(t)) await Target.findByIdAndUpdate(t._id, { reminderSentAt: new Date() });
      else await sendReminder(t, adminIds, tenantDB, Target, tomorrow);
    } else if (!t.dueTodaySentAt && endDate >= today && endDate <= todayEnd) {
      if (isAlreadyCompleted(t)) await Target.findByIdAndUpdate(t._id, { dueTodaySentAt: new Date() });
      else await sendDueToday(t, adminIds, tenantDB, models, today);
    }
  } catch (e) {
    console.error(`checkTargetDeadlineNow error for target ${targetId}:`, e.message);
  }
};

let targetCronTask = null;

export const startTargetCron = () => {
  if (targetCronTask) targetCronTask.stop();
  // Runs every 15 minutes so reminders/due-today/expiry are caught promptly
  // (a target created mid-day with a next-day deadline no longer has to wait
  // for a fixed once-daily run).
  targetCronTask = cron.schedule("*/15 * * * *", async () => {
    try {
      await runTargetDeadlineCron();
    } catch (err) {
      console.error("Target deadline cron error:", err);
    }
  });
  console.log(`Target Management Cron started: ${new Date().toISOString()}`);

  // Run once immediately on boot instead of waiting for the first tick.
  runTargetDeadlineCron().catch((err) => console.error("Initial target deadline run error:", err));
};

startTargetCron();

process.on("SIGINT", () => { if (targetCronTask) targetCronTask.stop(); });
process.on("SIGTERM", () => { if (targetCronTask) targetCronTask.stop(); });
