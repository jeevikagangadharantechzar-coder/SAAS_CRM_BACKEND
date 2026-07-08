// Dedicated cron for Task Management due-date reminders — tomorrow + due-today
// — mirrors the pattern in cron/targetCron.js but scoped to Tasks.
import cron from "node-cron";
import { notifyUser } from "../realtime/socket.js";
import { getTenantDB } from "../config/tenantDB.js";
import { getTenantModels } from "../models/tenant/index.js";
import Tenant from "../models/master/Tenant.js";

async function createNotification(Notification, { userId, title, message, type, meta }) {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const notif = await Notification.create({
    userId, title, message, text: message, type, meta, expiresAt, read: false, isRead: false,
  });
  notifyUser(String(userId), "new_notification", {
    _id: notif._id, title, text: message, message, type, meta, createdAt: notif.createdAt,
  });
  return notif;
}

export const getAdminIds = async (User, Role) => {
  const adminRole = await Role.findOne({ name: "Admin" }).lean();
  if (!adminRole) return [];
  const admins = await User.find({ role: adminRole._id, status: "Active" }).select("_id").lean();
  return admins.map((u) => String(u._id));
};

// dueDate is stored as a plain Date; anchor "today"/"tomorrow" windows in UTC-day
// space so day boundaries never shift depending on the server's local timezone.
const utcDayStart = (daysFromNow = 0) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysFromNow));
};
const utcDayEnd = (dayStart) => new Date(dayStart.getTime() + 24 * 60 * 60 * 1000 - 1);

const linkedItemLine = (t) => {
  const lead = t.leadRef?.leadName ? `Lead: ${t.leadRef.leadName}` : null;
  const deal = t.dealRef?.dealName || t.dealRef?.dealTitle ? `Deal: ${t.dealRef.dealName || t.dealRef.dealTitle}` : null;
  return [lead, deal].filter(Boolean).join(" · ");
};

// Snapshot of the task's linked lead/deal contact info, attached to
// notification meta so the frontend can render name/email/phone directly.
const buildLinkedMeta = (t) => {
  const lead = t.leadRef;
  const deal = t.dealRef;
  if (lead?.leadName) {
    return { linkedType: "lead", linkedName: lead.leadName, linkedCompany: lead.companyName || null, linkedPhone: lead.phoneNumber || null, linkedEmail: lead.email || null };
  }
  if (deal) {
    return { linkedType: "deal", linkedName: deal.dealName || deal.dealTitle || null, linkedCompany: deal.companyName || null, linkedPhone: deal.phoneNumber || null, linkedEmail: deal.email || null };
  }
  return {};
};

const sendReminder = async (t, adminIds, Task, Notification, tomorrow) => {
  const salesName = `${t.assignedTo.firstName} ${t.assignedTo.lastName}`;
  const linked = linkedItemLine(t);
  const linkedMeta = buildLinkedMeta(t);

  const salesMsg = `⏰ Tomorrow (${tomorrow.toDateString()}) is the due date for your task: "${t.title}"${linked ? ` (${linked})` : ""} — please finish it before the deadline!`;
  await createNotification(Notification, { userId: t.assignedTo._id, title: "Task Deadline Tomorrow", message: salesMsg, type: "task", meta: { taskId: String(t._id), taskReminder: true, ...linkedMeta } });

  const adminMsg = `⏰ Reminder: tomorrow (${tomorrow.toDateString()}) is the due date for ${salesName}'s task: "${t.title}"${linked ? ` (${linked})` : ""} — reassign if it needs to move to someone else.`;
  for (const adminId of adminIds) {
    await createNotification(Notification, { userId: adminId, title: "Task Deadline Tomorrow", message: adminMsg, type: "task", meta: { taskId: String(t._id), taskReminder: true, salesName, needsReassign: true, ...linkedMeta } });
  }

  await Task.findByIdAndUpdate(t._id, { reminderSentAt: new Date() });
};

export const sendDueToday = async (t, adminIds, Task, Notification, today) => {
  const salesName = `${t.assignedTo.firstName} ${t.assignedTo.lastName}`;
  const linked = linkedItemLine(t);
  const linkedMeta = buildLinkedMeta(t);

  const salesMsg = `🚨 Today (${today.toDateString()}) is the due date for your task: "${t.title}"${linked ? ` (${linked})` : ""}.`;
  await createNotification(Notification, { userId: t.assignedTo._id, title: "Task Due Today", message: salesMsg, type: "task", meta: { taskId: String(t._id), taskDueToday: true, ...linkedMeta } });

  const adminMsg = `🚨 Today is the due date for ${salesName}'s task: "${t.title}"${linked ? ` (${linked})` : ""} — reassign if it needs to move to someone else.`;
  for (const adminId of adminIds) {
    await createNotification(Notification, { userId: adminId, title: "Task Due Today", message: adminMsg, type: "task", meta: { taskId: String(t._id), taskDueToday: true, salesName, needsReassign: true, ...linkedMeta } });
  }

  await Task.findByIdAndUpdate(t._id, { dueTodaySentAt: new Date() });
};

const processTasks = async (models, tenantDB) => {
  if (!models.Task || !models.User || !models.Role || !models.Notification) return;
  const { Task, User, Role, Notification } = models;

  const today = utcDayStart(0);
  const todayEnd = utcDayEnd(today);
  const tomorrow = utcDayStart(1);
  const tomorrowEnd = utcDayEnd(tomorrow);

  const adminIds = await getAdminIds(User, Role);

  const tomorrowTasks = await Task.find({
    dueDate: { $gte: tomorrow, $lte: tomorrowEnd },
    reminderSentAt: null,
    status: { $ne: "Completed" },
  }).populate("assignedTo", "firstName lastName _id")
    .populate("leadRef", "leadName companyName phoneNumber email")
    .populate("dealRef", "dealName dealTitle companyName phoneNumber email")
    .lean();

  for (const t of tomorrowTasks) {
    try {
      if (!t.assignedTo) continue;
      await sendReminder(t, adminIds, Task, Notification, tomorrow);
    } catch (e) {
      console.error(`Task reminder error for task ${t._id}:`, e.message);
    }
  }

  const dueTodayTasks = await Task.find({
    dueDate: { $gte: today, $lte: todayEnd },
    dueTodaySentAt: null,
    status: { $ne: "Completed" },
  }).populate("assignedTo", "firstName lastName _id")
    .populate("leadRef", "leadName companyName phoneNumber email")
    .populate("dealRef", "dealName dealTitle companyName phoneNumber email")
    .lean();

  for (const t of dueTodayTasks) {
    try {
      if (!t.assignedTo) continue;
      await sendDueToday(t, adminIds, Task, Notification, today);
    } catch (e) {
      console.error(`Task due-today error for task ${t._id}:`, e.message);
    }
  }
};

// ── Per-lead/deal due-date reminders ────────────────────────────────────
// A newly-linked lead/deal added during a Task edit can carry its own due
// date (task.leadDueDates/task.dealDueDates, set in TaskManagement.jsx's
// edit modal) separate from the task's own dueDate above. Same
// tomorrow/due-today windows and one-shot-guard idea as processTasks above,
// just scoped per linked item instead of per task — entirely additive, never
// touches or interacts with the task-level reminderSentAt/dueTodaySentAt
// guards, and does nothing at all for a task with no per-item due dates set.
const sendItemReminder = async (t, itemId, isDeal, name, adminIds, Task, Notification, tomorrow, sentAtField) => {
  const salesName = `${t.assignedTo.firstName} ${t.assignedTo.lastName}`;
  const kind = isDeal ? "deal" : "lead";
  const line = `${isDeal ? "Deal" : "Lead"}: ${name}`;
  // "Lead"/"Deal" Deadline Tomorrow — same naming convention as the task's own
  // "Task Deadline Tomorrow" title, instead of the generic "Item" wording.
  const title = isDeal ? "Deal Deadline Tomorrow" : "Lead Deadline Tomorrow";
  const meta = { taskId: String(t._id), taskReminder: true, itemDueReminder: true, linkedType: kind, linkedId: String(itemId), linkedName: name };

  const salesMsg = `⏰ Tomorrow (${tomorrow.toDateString()}) is the due date for ${line} on your task "${t.title}" — please finish it before the deadline!`;
  await createNotification(Notification, { userId: t.assignedTo._id, title, message: salesMsg, type: "task", meta });

  const adminMsg = `⏰ Reminder: tomorrow (${tomorrow.toDateString()}) is the due date for ${salesName}'s ${line.toLowerCase()} on task "${t.title}".`;
  for (const adminId of adminIds) {
    // needsReassign: true — same Reassign button + flow the task's own
    // due-date reminder notification already gives Admin (reassignTask
    // endpoint reassigns the whole task, transferring its linked leads/deals
    // and notifying both the new assignee and the sales person who
    // previously held them).
    await createNotification(Notification, { userId: adminId, title, message: adminMsg, type: "task", meta: { ...meta, salesName, needsReassign: true } });
  }

  await Task.findByIdAndUpdate(t._id, { $set: { [`${sentAtField}.${itemId}`]: new Date() } });
};

export const sendItemDueToday = async (t, itemId, isDeal, name, adminIds, Task, Notification, today, sentAtField) => {
  const salesName = `${t.assignedTo.firstName} ${t.assignedTo.lastName}`;
  const kind = isDeal ? "deal" : "lead";
  const line = `${isDeal ? "Deal" : "Lead"}: ${name}`;
  const title = isDeal ? "Deal Due Today" : "Lead Due Today";
  const meta = { taskId: String(t._id), taskDueToday: true, itemDueToday: true, linkedType: kind, linkedId: String(itemId), linkedName: name };

  const salesMsg = `🚨 Today (${today.toDateString()}) is the due date for ${line} on your task "${t.title}".`;
  await createNotification(Notification, { userId: t.assignedTo._id, title, message: salesMsg, type: "task", meta });

  const adminMsg = `🚨 Today is the due date for ${salesName}'s ${line.toLowerCase()} on task "${t.title}".`;
  for (const adminId of adminIds) {
    await createNotification(Notification, { userId: adminId, title, message: adminMsg, type: "task", meta: { ...meta, salesName, needsReassign: true } });
  }

  await Task.findByIdAndUpdate(t._id, { $set: { [`${sentAtField}.${itemId}`]: new Date() } });
};

const processLeadDealDueDates = async (models) => {
  if (!models.Task || !models.User || !models.Role || !models.Notification || !models.Lead || !models.Deal) return;
  const { Task, User, Role, Notification, Lead, Deal } = models;

  const today = utcDayStart(0);
  const todayEnd = utcDayEnd(today);
  const tomorrow = utcDayStart(1);
  const tomorrowEnd = utcDayEnd(tomorrow);
  const adminIds = await getAdminIds(User, Role);

  // Cheap Mongo-side filter — only tasks that actually have at least one
  // per-item due date set, before doing any per-task JS work below.
  const tasks = await Task.find({
    status: { $ne: "Completed" },
    archived: { $ne: true },
    $or: [
      { leadDueDates: { $exists: true, $ne: {} } },
      { dealDueDates: { $exists: true, $ne: {} } },
    ],
  }).populate("assignedTo", "firstName lastName _id").lean();

  if (!tasks.length) return;

  // Batch-resolve every referenced lead/deal's name in two queries total,
  // instead of one lookup per linked item.
  const leadIds = new Set();
  const dealIds = new Set();
  tasks.forEach((t) => {
    Object.keys(t.leadDueDates || {}).forEach((id) => leadIds.add(id));
    Object.keys(t.dealDueDates || {}).forEach((id) => dealIds.add(id));
  });
  const [leads, deals] = await Promise.all([
    leadIds.size ? Lead.find({ _id: { $in: [...leadIds] } }).select("leadName").lean() : [],
    dealIds.size ? Deal.find({ _id: { $in: [...dealIds] } }).select("dealName dealTitle").lean() : [],
  ]);
  const leadNameById = new Map(leads.map((l) => [String(l._id), l.leadName]));
  const dealNameById = new Map(deals.map((d) => [String(d._id), d.dealName || d.dealTitle]));

  for (const t of tasks) {
    if (!t.assignedTo) continue;
    try {
      const leadReminderSent = t.leadDueReminderSentAt || {};
      const leadDueTodaySent = t.leadDueTodaySentAt || {};
      for (const [leadId, dueRaw] of Object.entries(t.leadDueDates || {})) {
        const due = new Date(dueRaw);
        const name = leadNameById.get(leadId) || "a linked lead";
        if (due >= tomorrow && due <= tomorrowEnd && !leadReminderSent[leadId]) {
          await sendItemReminder(t, leadId, false, name, adminIds, Task, Notification, tomorrow, "leadDueReminderSentAt");
        }
        if (due >= today && due <= todayEnd && !leadDueTodaySent[leadId]) {
          await sendItemDueToday(t, leadId, false, name, adminIds, Task, Notification, today, "leadDueTodaySentAt");
        }
      }

      const dealReminderSent = t.dealDueReminderSentAt || {};
      const dealDueTodaySent = t.dealDueTodaySentAt || {};
      for (const [dealId, dueRaw] of Object.entries(t.dealDueDates || {})) {
        const due = new Date(dueRaw);
        const name = dealNameById.get(dealId) || "a linked deal";
        if (due >= tomorrow && due <= tomorrowEnd && !dealReminderSent[dealId]) {
          await sendItemReminder(t, dealId, true, name, adminIds, Task, Notification, tomorrow, "dealDueReminderSentAt");
        }
        if (due >= today && due <= todayEnd && !dealDueTodaySent[dealId]) {
          await sendItemDueToday(t, dealId, true, name, adminIds, Task, Notification, today, "dealDueTodaySentAt");
        }
      }
    } catch (e) {
      console.error(`Lead/deal due-date reminder error for task ${t._id}:`, e.message);
    }
  }
};

export const runTaskDeadlineCron = async () => {
  let tenants = [];
  try {
    tenants = await Tenant.find({ isActive: true }).lean();
  } catch (e) {
    console.warn("TaskCron: could not load tenants:", e.message);
  }

  for (const tenant of tenants) {
    try {
      const tenantDB = await getTenantDB(tenant.dbName);
      const models = getTenantModels(tenantDB);
      await processTasks(models, tenantDB);
      await processLeadDealDueDates(models);
    } catch (e) {
      console.error(`Task cron error for tenant ${tenant.slug}:`, e.message);
    }
  }
};

let taskCronTask = null;

export const startTaskCron = () => {
  if (taskCronTask) taskCronTask.stop();
  // Runs every 15 minutes, same cadence as the target-deadline cron.
  taskCronTask = cron.schedule("*/15 * * * *", async () => {
    try {
      await runTaskDeadlineCron();
    } catch (err) {
      console.error("Task deadline cron error:", err);
    }
  });
  console.log(`Task Management Cron started: ${new Date().toISOString()}`);

  runTaskDeadlineCron().catch((err) => console.error("Initial task deadline run error:", err));
};

startTaskCron();

process.on("SIGINT", () => { if (taskCronTask) taskCronTask.stop(); });
process.on("SIGTERM", () => { if (taskCronTask) taskCronTask.stop(); });