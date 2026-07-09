// Dedicated module for everything related to Task Management notifications —
// persisting + emitting them, finding admins, building linked-item metadata,
// and the live "tasks_refresh" broadcast. Kept separate from task.controller.js
// so task notification logic lives in one place instead of being mixed in
// with request handlers.
import { notifyUser } from "../realtime/socket.js";
import { notifyTargetUser } from "../realtime/targetSocket.js";
import { getLinkage } from "./linkageService.js";

// Persist a notification in the DB and emit it live via socket.
export async function createNotification(Notification, { userId, title, message, type, meta }) {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  const notif = await Notification.create({
    userId,
    title,
    message,
    text: message,
    type,
    meta,
    expiresAt,
    read: false,
    isRead: false,
  });
  notifyUser(String(userId), "new_notification", {
    _id: notif._id,
    title,
    text: message,
    message,
    type,
    meta,
    createdAt: notif.createdAt,
  });
  return notif;
}

// Find all active admin users in this tenant.
export async function findAdmins(User, Role) {
  const adminRole = await Role.findOne({ name: "Admin" });
  if (!adminRole) return [];
  return User.find({ role: adminRole._id, status: "Active" }).select("_id");
}

// Live-refresh signal so both the admin Task Management list and the sales
// person's My Tasks list update instantly on any task mutation — no manual
// page refresh, no refetch-triggered loading blink (the frontend calls
// fetchTasks(false) on this event).
export async function broadcastTasksRefresh(User, Role, extraUserIds = []) {
  const admins = await findAdmins(User, Role);
  const ids = new Set([...admins.map((a) => String(a._id)), ...extraUserIds.filter(Boolean).map(String)]);
  ids.forEach((uid) => notifyUser(uid, "tasks_refresh", {}));
}

// A linked deal an Admin has actually pushed a stage move on — i.e. the admin
// is doing the hands-on work on it. Requires stageHistory.movedBy populated
// with { firstName, lastName, role: { name } }.
export function getTakenByAdminName(stageHistory, ownerIdStr) {
  const adminMoves = (stageHistory || []).filter((h) => {
    if (!h.movedBy || typeof h.movedBy !== "object") return false;
    if (String(h.movedBy._id) === ownerIdStr) return false;
    return h.movedBy.role?.name === "Admin";
  });
  if (!adminMoves.length) return null;
  const latest = adminMoves[adminMoves.length - 1].movedBy;
  return `${latest.firstName || ""} ${latest.lastName || ""}`.trim();
}

// Shared between the dealRef populate below and attachConvertedDealJourney's
// standalone Deal lookup, so both return the same shape DealStageJourney needs.
const DEAL_SELECT_FIELDS = "dealName dealTitle stage assignedTo convertedBy wonBy stageHistory companyName phoneNumber email value currency createdAt wonAt convertedAt leadCreatedAt leadStatusHistory leadId";
const DEAL_POPULATE_SUBFIELDS = [
  { path: "convertedBy", select: "firstName lastName role", populate: { path: "role", select: "name" } },
  { path: "wonBy", select: "firstName lastName role", populate: { path: "role", select: "name" } },
  { path: "stageHistory.movedBy", select: "firstName lastName role", populate: { path: "role", select: "name" } },
];

const LEAD_SELECT_FIELDS = "leadName companyName status convertedBy phoneNumber email createdAt statusHistory";
const LEAD_POPULATE_SUBFIELDS = { path: "convertedBy", select: "firstName lastName role", populate: { path: "role", select: "name" } };

export const LEAD_DEAL_POPULATE = [
  { path: "assignedTo", select: "firstName lastName email profileImage" },
  { path: "createdBy", select: "firstName lastName email" },
  {
    path: "leadRef",
    select: LEAD_SELECT_FIELDS,
    populate: LEAD_POPULATE_SUBFIELDS,
  },
  {
    path: "dealRef",
    select: DEAL_SELECT_FIELDS,
    populate: DEAL_POPULATE_SUBFIELDS,
  },
  // Full multi-link history — populated the same way as the singular
  // primary fields above so the frontend can render every linked item,
  // not just the most-recently-linked one.
  {
    path: "leadRefs",
    select: LEAD_SELECT_FIELDS,
    populate: LEAD_POPULATE_SUBFIELDS,
  },
  {
    path: "dealRefs",
    select: DEAL_SELECT_FIELDS,
    populate: DEAL_POPULATE_SUBFIELDS,
  },
  { path: "history.by", select: "firstName lastName" },
];

// Backward-compat derived array for tasks created before the leadRefs/
// dealRefs migration — they only ever set the singular leadRef/dealRef.
// Called on every lean task object returned to the frontend so leadRefs/
// dealRefs are ALWAYS present, regardless of when the task was created.
// Never touches leadRef/dealRef themselves — those stay exactly as read by
// every existing Progress Card / cron / badge computation.
// Mongoose Map-typed fields (leadDueDates/dealDueDates) come back as a native
// Map instance from a hydrated document's .toObject() (e.g. after
// findByIdAndUpdate), but as a plain object from a .lean() query — JSON.stringify
// silently drops a Map's contents (res.json would send "{}"), so every read
// path is normalized here to guarantee a plain { id: isoDateString } object.
function toPlainDateMap(mapField) {
  if (!mapField) return {};
  if (mapField instanceof Map) return Object.fromEntries(mapField);
  return mapField;
}

export function attachLinkedArrays(taskObj) {
  taskObj.leadRefs = (taskObj.leadRefs && taskObj.leadRefs.length) ? taskObj.leadRefs : (taskObj.leadRef ? [taskObj.leadRef] : []);
  taskObj.dealRefs = (taskObj.dealRefs && taskObj.dealRefs.length) ? taskObj.dealRefs : (taskObj.dealRef ? [taskObj.dealRef] : []);
  taskObj.leadDueDates = toPlainDateMap(taskObj.leadDueDates);
  taskObj.dealDueDates = toPlainDateMap(taskObj.dealDueDates);
  return taskObj;
}

// A task can be linked to a Lead that has SINCE been converted into a Deal —
// nobody goes back and re-points task.dealRef at the resulting deal, so the
// task's own leadRef stays frozen at its pre-conversion state. Without this,
// Task Management/Assigned Tasks can only show the lead's own (now stale,
// partial) status history and never the deal-stage portion of the journey
// (Qualification → ... → Closed Won) that happened after conversion — this
// is why the full Stage Journey appeared to "not show" for those tasks.
// Batch-resolves the corresponding Deal (by leadId) for every converted lead
// across the task's FULL multi-link array (leadRefs), not just the single
// primary leadRef. A task can hold several converted leads at once (e.g. one
// already Closed Won, another just added during an edit) — each needs its
// own resolved deal journey, independent of which lead happens to be primary
// right now. Without this, adding a new lead/deal on edit re-points
// task.leadRef (task.controller.js updateTask always sets it to the
// LAST-added id) — demoting a previously-primary, already-converted/won lead
// to non-primary, which silently dropped its whole Stage Journey and made it
// render as a bare "Converted" lead card instead of its full Won deal card.
// `convertedDealRefsByLeadId` (keyed by lead id, plain object) is the new,
// complete lookup every card should use. `convertedDealRef` (singular) is
// still set for the primary lead too, purely for backward compatibility with
// any other existing reader of that single field.
export async function attachConvertedDealJourney(Deal, tasks) {
  const leadIdToEntries = new Map(); // leadId -> [{ task, isPrimary }]
  tasks.forEach((t) => {
    const leadItems = (t.leadRefs && t.leadRefs.length) ? t.leadRefs : (t.leadRef ? [t.leadRef] : []);
    const primaryLeadId = t.leadRef?._id ? String(t.leadRef._id) : (t.leadRef ? String(t.leadRef) : null);
    leadItems.forEach((lead) => {
      if (!lead || lead.status !== "Converted") return;
      const leadId = String(lead._id);
      if (!leadIdToEntries.has(leadId)) leadIdToEntries.set(leadId, []);
      leadIdToEntries.get(leadId).push({ task: t, isPrimary: leadId === primaryLeadId });
    });
  });
  if (!leadIdToEntries.size) return tasks;

  const leadIds = [...leadIdToEntries.keys()];
  const deals = await Deal.find({ leadId: { $in: leadIds } })
    .select(DEAL_SELECT_FIELDS)
    .populate(DEAL_POPULATE_SUBFIELDS)
    .lean();
  const dealByLeadId = new Map(deals.map((d) => [String(d.leadId), d]));

  leadIdToEntries.forEach((entries, leadId) => {
    const deal = dealByLeadId.get(leadId);
    if (!deal) return;
    entries.forEach(({ task: t, isPrimary }) => {
      t.convertedDealRefsByLeadId = { ...(t.convertedDealRefsByLeadId || {}), [leadId]: deal };
      if (isPrimary && !t.dealRef) t.convertedDealRef = deal;
    });
  });
  return tasks;
}

// Attach a "who converted the lead / moved the deal" badge summary onto a
// (lean) task object, so the frontend doesn't need to re-derive it.
export function attachLinkedItemBadge(taskObj) {
  const lead = taskObj.leadRef;
  const deal = taskObj.dealRef;
  const assignedToId = String(taskObj.assignedTo?._id || taskObj.assignedTo || "");

  if (lead?.convertedBy) {
    const isSelf = String(lead.convertedBy._id) === assignedToId;
    taskObj.linkedItemBadge = {
      kind: "lead",
      isSelf,
      isAdmin: lead.convertedBy.role?.name === "Admin",
      name: `${lead.convertedBy.firstName || ""} ${lead.convertedBy.lastName || ""}`.trim(),
    };
  } else if (deal) {
    const dealOwnerId = String(deal.assignedTo?._id || deal.assignedTo || assignedToId);
    const takenByAdminName = getTakenByAdminName(deal.stageHistory, dealOwnerId);
    if (takenByAdminName) {
      taskObj.linkedItemBadge = { kind: "deal_stage", isSelf: false, isAdmin: true, name: takenByAdminName };
    } else if (deal.convertedBy) {
      const isSelf = String(deal.convertedBy._id) === dealOwnerId;
      taskObj.linkedItemBadge = {
        kind: "deal_converted",
        isSelf,
        isAdmin: deal.convertedBy.role?.name === "Admin",
        name: `${deal.convertedBy.firstName || ""} ${deal.convertedBy.lastName || ""}`.trim(),
      };
    } else if (deal.wonBy) {
      const isSelf = String(deal.wonBy._id || deal.wonBy) === dealOwnerId;
      taskObj.linkedItemBadge = {
        kind: "deal_won",
        isSelf,
        isAdmin: deal.wonBy.role?.name === "Admin",
        name: `${deal.wonBy.firstName || ""} ${deal.wonBy.lastName || ""}`.trim(),
      };
    }
  }
  return taskObj;
}

// Snapshot of the task's linked lead/deal contact info, attached to
// notification meta so the frontend can render name/email/phone without a
// second lookup.
export function buildLinkedMeta(task) {
  const lead = task.leadRef;
  const deal = task.dealRef;
  if (lead?.leadName) {
    return {
      linkedType: "lead",
      linkedName: lead.leadName,
      linkedCompany: lead.companyName || null,
      linkedPhone: lead.phoneNumber || null,
      linkedEmail: lead.email || null,
    };
  }
  if (deal) {
    return {
      linkedType: "deal",
      linkedName: deal.dealName || deal.dealTitle || null,
      linkedCompany: deal.companyName || null,
      linkedPhone: deal.phoneNumber || null,
      linkedEmail: deal.email || null,
    };
  }
  return {};
}

// Called from deals.controller.js whenever an Admin moves the stage of a
// deal that isn't "Closed Won" (that has its own dedicated notification —
// see notifyDealClosedWonAndArchiveTask below). This is the ONE place a
// stage-change notification gets created — deals.controller.js used to also
// create a second, separate "target"-typed notification for the same event,
// which meant the sales person saw two near-duplicate notifications (one in
// My Task, one in My Target) for a single stage move. That legacy block has
// been removed; this is now the single source of truth, always typed "task"
// with a clear meta flag so both My Task and My Target pick it up consistently.
export async function notifyDealStageChangedByAdmin(models, { deal, stage, previousStage, actorId }) {
  const { Notification, User } = models;
  const assigneeId = deal.assignedTo ? String(deal.assignedTo._id || deal.assignedTo) : null;
  if (!Notification || !assigneeId) return;
  if (String(actorId) === assigneeId) return; // sales moved their own deal — no notification needed

  const actor = await User.findById(actorId).select("firstName lastName");
  const adminName = actor ? `${actor.firstName || ""} ${actor.lastName || ""}`.trim() : "Admin";

  // Route by actual linkage — a deal linked only to a Target must never
  // surface a "task"-typed notification in Task Management (and vice versa).
  // A deal linked to neither falls back to "task" (unchanged legacy behavior
  // for plain, non-task, non-target deal edits).
  const { isTaskLinked, isTargetLinked } = await getLinkage(models, { dealId: deal._id });

  if (isTaskLinked || !isTargetLinked) {
    await createNotification(Notification, {
      userId: assigneeId,
      title: `Deal Stage Updated by Admin ${adminName}`,
      message: `Admin ${adminName} moved your deal "${deal.dealName}" from "${previousStage}" to "${stage}" stage.`,
      type: "task",
      meta: { taskDealStageUpdated: true, dealId: String(deal._id), dealName: deal.dealName, stage, previousStage, adminName },
    });
  }
  if (isTargetLinked) {
    await createNotification(Notification, {
      userId: assigneeId,
      title: `Deal Stage Updated by Admin ${adminName}`,
      message: `Admin ${adminName} moved your target-linked deal "${deal.dealName}" from "${previousStage}" to "${stage}" stage.`,
      type: "target",
      meta: { targetDealStageUpdated: true, dealId: String(deal._id), dealName: deal.dealName, stage, previousStage, adminName },
    });
    notifyTargetUser(assigneeId, "targets_refresh", {});
  }
}

// Same idea as notifyDealStageChangedByAdmin, but for a lead's status change
// (Cold/Warm/Hot/Junk) — replaces the old duplicate "target"-typed block in
// leads.controller.js's updateLead.
export async function notifyLeadStatusChangedByAdmin(models, { lead, status, previousStatus, actorId }) {
  const { Notification, User } = models;
  const assigneeId = lead.assignTo ? String(lead.assignTo._id || lead.assignTo) : null;
  if (!Notification || !assigneeId) return;
  if (String(actorId) === assigneeId) return;

  const actor = await User.findById(actorId).select("firstName lastName");
  const adminName = actor ? `${actor.firstName || ""} ${actor.lastName || ""}`.trim() : "Admin";

  const { isTaskLinked, isTargetLinked } = await getLinkage(models, { leadId: lead._id });

  if (isTaskLinked || !isTargetLinked) {
    await createNotification(Notification, {
      userId: assigneeId,
      title: `Lead Status Updated by Admin ${adminName}`,
      message: `Admin ${adminName} moved your lead "${lead.leadName}" from "${previousStatus}" to "${status}" status.`,
      type: "task",
      meta: { leadStatusChanged: true, leadId: String(lead._id), leadName: lead.leadName, status, previousStatus, adminName },
    });
  }
  if (isTargetLinked) {
    await createNotification(Notification, {
      userId: assigneeId,
      title: `Lead Status Updated by Admin ${adminName}`,
      message: `Admin ${adminName} moved your target-linked lead "${lead.leadName}" from "${previousStatus}" to "${status}" status.`,
      type: "target",
      meta: { targetLeadStatusChanged: true, leadId: String(lead._id), leadName: lead.leadName, status, previousStatus, adminName },
    });
    notifyTargetUser(assigneeId, "targets_refresh", {});
  }
}

// Called right after Admin converts a lead into a deal (createDealFromLead).
// The sales person owning the lead currently gets no notification at all
// about this — this closes that gap.
export async function notifyLeadConvertedByAdmin(models, { lead, deal, actorId }) {
  const { Notification, User } = models;
  const assigneeId = lead.assignTo ? String(lead.assignTo._id || lead.assignTo) : null;
  if (!Notification || !assigneeId) return;
  if (String(actorId) === assigneeId) return; // sales converted their own lead — no notification needed

  const actor = await User.findById(actorId).select("firstName lastName");
  const adminName = actor ? `${actor.firstName || ""} ${actor.lastName || ""}`.trim() : "Admin";

  const { isTaskLinked, isTargetLinked } = await getLinkage(models, { leadId: lead._id });

  if (isTaskLinked || !isTargetLinked) {
    await createNotification(Notification, {
      userId: assigneeId,
      title: `Lead Converted to Deal by Admin ${adminName}`,
      message: `Admin ${adminName} converted your lead "${lead.leadName}" into a deal — it now starts at the Qualification stage.`,
      type: "task",
      meta: { leadConverted: true, leadId: String(lead._id), dealId: String(deal._id), dealName: deal.dealName, adminName },
    });
  }
  if (isTargetLinked) {
    await createNotification(Notification, {
      userId: assigneeId,
      title: `Lead Converted to Deal by Admin ${adminName}`,
      message: `Admin ${adminName} converted your target-linked lead "${lead.leadName}" into a deal — it now starts at the Qualification stage.`,
      type: "target",
      meta: { targetLeadConverted: true, leadId: String(lead._id), dealId: String(deal._id), dealName: deal.dealName, adminName },
    });
    notifyTargetUser(assigneeId, "targets_refresh", {});
  }
}

// Called when Admin edits a lead/deal's general fields (not just status/stage,
// which already have their own notifications) while it's assigned to someone
// else — e.g. changing phone/email/company/requirement/value.
export async function notifyLeadOrDealEdited(models, { itemType, item, actorId, adminName }) {
  const { Notification } = models;
  const assigneeId = item.assignTo || item.assignedTo
    ? String((item.assignTo || item.assignedTo)._id || item.assignTo || item.assignedTo)
    : null;
  if (!Notification || !assigneeId) return;
  if (String(actorId) === assigneeId) return;

  const itemName = itemType === "lead" ? item.leadName : (item.dealName || item.dealTitle);
  const label = itemType === "lead" ? "lead" : "deal";

  await createNotification(Notification, {
    userId: assigneeId,
    title: `${label === "lead" ? "Lead" : "Deal"} Updated by Admin ${adminName}`,
    message: `Admin ${adminName} updated the details of your ${label} "${itemName}".`,
    type: "task",
    meta: { leadOrDealEdited: true, itemType, itemId: String(item._id), itemName, adminName },
  });
}

// Called when a deal moves to "Closed Won" (from deals.controller's updateStage
// and updateDeal). The task and its full progress card/journey stay visible
// on the assignee's own My Tasks list regardless of who closed the deal —
// Admin closing it on their behalf is no longer treated any differently from
// the assignee closing it themselves; only the notification wording differs.
// Sends the assignee a distinct celebratory notification depending on who
// actually closed it, and live-refreshes their Task/Target pages so this all
// happens immediately, without a manual reload.
export async function notifyDealClosedWonAndArchiveTask(models, { deal, actorId, isAdminActor }) {
  const { Notification, User } = models;
  const assigneeId = deal.assignedTo ? String(deal.assignedTo._id || deal.assignedTo) : null;
  const isSelf = String(actorId) === assigneeId;

  // Live-refresh the assignee's own Target/Task pages — without this, their
  // task card and "Won Deals" list would keep showing the stale pre-won
  // state until they manually reload.
  if (assigneeId) {
    notifyTargetUser(assigneeId, "targets_refresh", {});
    notifyUser(assigneeId, "tasks_refresh", {});
  }

  if (!Notification || !assigneeId) return;

  if (isSelf) {
    await createNotification(Notification, {
      userId: assigneeId,
      title: "Deal Completed",
      message: `You successfully completed this deal! Thank you for the great work!`,
      type: "task",
      meta: { dealClosedWon: true, dealCompletedBySelf: true, dealId: String(deal._id), dealName: deal.dealName },
    });
  } else if (isAdminActor) {
    const actor = await User.findById(actorId).select("firstName lastName");
    const adminName = actor ? `${actor.firstName || ""} ${actor.lastName || ""}`.trim() : "Admin";
    await createNotification(Notification, {
      userId: assigneeId,
      title: "Deal Completed by Admin",
      message: `Admin ${adminName} closed your deal "${deal.dealName}" as Won.`,
      type: "task",
      meta: { dealClosedWon: true, dealCompletedByAdmin: true, dealId: String(deal._id), dealName: deal.dealName, adminName },
    });
  }
}
