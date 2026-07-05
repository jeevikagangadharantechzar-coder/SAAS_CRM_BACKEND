// Dedicated module for everything related to Target Management notifications —
// persisting + emitting them, finding admins, and the "who's actually working
// this deal" badge helper. Deliberately separate from
// services/taskNotificationService.js: Target notifications (type "target",
// "target_reminder", "target_due_today", "target_expired", "target_reassign")
// and Task notifications (type "task") are two independent families that
// never overlap in the UI — My Targets only ever renders the former, Task
// Management / Assigned Tasks only ever render the latter. Keeping their
// creation logic in separate files (rather than one shared "notifications"
// module both controllers reach into) keeps that boundary structural instead
// of just a convention someone can accidentally break.
import { notifyUser } from "../realtime/socket.js";

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

// A deal an Admin has actually pushed a stage move on — i.e. the admin is
// doing the hands-on work on it, whether or not it was ever lead-converted.
// Requires stageHistory.movedBy to be populated with { firstName, lastName, role: { name } }.
// Excludes moves made by the deal's own owner, in case an Admin is the assignee themselves.
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

export const STAGE_HISTORY_MOVER_POPULATE = {
  path: "stageHistory.movedBy",
  select: "firstName lastName role",
  populate: { path: "role", select: "name" },
};

// Whether the CURRENT "Closed Lost" state was actually set by this user
// themselves — same self-only rule the target progress card already applies
// to leadsConverted/dealsWon/leadDealWon (see computeActuals and leadDealWon
// in target.controller.js). Deals have no dedicated "lostBy" field the way
// they have "wonBy" for wins, so this reads it off stageHistory (already
// populated via STAGE_HISTORY_MOVER_POPULATE) instead — the most recent
// "Closed Lost" entry's mover.
export function wasLostBySelf(stageHistory, idStr) {
  const lostMoves = (stageHistory || []).filter((h) => h.stage === "Closed Lost");
  if (!lostMoves.length) return false;
  const latest = lostMoves[lostMoves.length - 1];
  return String(latest.movedBy?._id || latest.movedBy || "") === idStr;
}
