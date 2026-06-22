import mongoose from "mongoose";
import moment from "moment";

// Legacy single-tenant imports (used when tenantDB is not provided)
import UserLegacy         from "../models/user.model.js";
import NotificationLegacy from "../models/notification.model.js";
import RoleLegacy         from "../models/role.model.js";

import { notifyUser } from "../realtime/socket.js";
import { getTenantModels } from "../models/tenant/index.js";

const DEDUP_MINUTES = 1440; // 24 hours

// ─────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────
const defaultTitleForType = (type, meta = {}) => {
  if (type === "followup") {
    if (meta.dealId)     return "Deal Follow-up";
    if (meta.proposalId) return "Proposal Follow-up";
    if (meta.leadId)     return "Lead Follow-up";
  }
  switch (type) {
    case "lead":         return "Lead Follow-up";
    case "deal":         return "Deal Follow-up";
    case "proposal":     return "Proposal Follow-up";
    case "contact_form": return "Website Contact Form";
    default:             return "Notification";
  }
};

/** Resolve the correct Notification + User models (tenant or legacy). */
const resolveModels = (tenantDB) => {
  if (tenantDB) {
    const models = getTenantModels(tenantDB);
    return { Notification: models.Notification, User: models.User, Role: models.Role };
  }
  return { Notification: NotificationLegacy, User: UserLegacy, Role: RoleLegacy };
};

// ─────────────────────────────────────────────
// sendNotification
// ─────────────────────────────────────────────
export const sendNotification = async (
  userId,
  text,
  type    = "followup",
  meta    = {},
  options = {},
  tenantDB = null
) => {
  try {
    console.log(` Creating notification for user ${userId}: ${text}`);

    const { Notification, User } = resolveModels(tenantDB);

    const cutoff      = moment().subtract(DEDUP_MINUTES, "minutes").toDate();
    const referenceId =
      options.referenceId ||
      meta.leadId         ||
      meta.dealId         ||
      meta.proposalId     ||
      meta.contactFormId  ||
      null;
    const followUpDate = options.followUpDate ? new Date(options.followUpDate) : null;

    const query = { userId, type, createdAt: { $gte: cutoff } };

    if (referenceId) {
      query.referenceId = referenceId.toString();
    } else if (meta && Object.keys(meta).length) {
      const orConditions = [];
      if (meta.leadId)       orConditions.push({ "meta.leadId":       meta.leadId });
      if (meta.dealId)       orConditions.push({ "meta.dealId":       meta.dealId });
      if (meta.proposalId)   orConditions.push({ "meta.proposalId":   meta.proposalId });
      if (meta.contactFormId)orConditions.push({ "meta.contactFormId":meta.contactFormId });
      if (orConditions.length) query.$or = orConditions;
    }

    if (followUpDate) query.followUpDate = followUpDate;

    const exists = await Notification.findOne(query);
    if (exists) {
      console.log("Duplicate notification found within 24 hours, skipping (no re-emit)");
      return exists;
    }

    let profileImage = options.profileImage || meta.profileImage || null;
    if (!profileImage) {
      const user = await User.findById(userId).select("profileImage");
      profileImage = user?.profileImage?.replace(/\\/g, "/") || null;
    }

    const notif = await Notification.create({
      userId,
      createdBy:   options.createdBy || null,
      type,
      title:       options.title || defaultTitleForType(type, meta),
      message:     text,
      text,
      referenceId: referenceId ? referenceId.toString() : null,
      followUpDate:options.followUpDate || null,
      read:        false,
      isRead:      false,
      meta,
      expiresAt:   moment().add(24, "hours").toDate(),
      profileImage,
    });

    console.log(` Notification created with ID: ${notif._id}`);

    notifyUser(userId, "new_notification", {
      id:          notif._id,
      title:       notif.title,
      message:     notif.message,
      text:        notif.text,
      type:        notif.type,
      meta:        notif.meta,
      referenceId: notif.referenceId,
      followUpDate:notif.followUpDate,
      profileImage:notif.profileImage,
      createdAt:   notif.createdAt,
      isRead:      notif.isRead,
    });

    return notif;
  } catch (error) {
    console.error(" Error in sendNotification:", error);
    throw error;
  }
};

// ─────────────────────────────────────────────
// getAdminUserIds
// ─────────────────────────────────────────────
export const getAdminUserIds = async (tenantDB = null) => {
  try {
    const { Role, User } = resolveModels(tenantDB);

    const adminRole = await Role.findOne({ name: { $regex: /^admin$/i } }).lean();
    if (!adminRole) return [];

    const admins = await User.find({ role: adminRole._id, status: "Active" })
      .select("_id")
      .lean();

    return admins.map((a) => String(a._id));
  } catch (error) {
    console.error(" Error fetching admin user IDs:", error);
    return [];
  }
};

// ─────────────────────────────────────────────
// sendNotificationToAdmins
// ─────────────────────────────────────────────
export const sendNotificationToAdmins = async (
  text,
  type           = "followup",
  meta           = {},
  options        = {},
  excludeUserIds = [],
  tenantDB       = null
) => {
  const admins  = await getAdminUserIds(tenantDB);
  const created = [];
  const excluded = excludeUserIds.map((id) => String(id));

  for (const adminId of admins) {
    if (excluded.includes(String(adminId))) continue;
    try {
      const notif = await sendNotification(adminId, text, type, meta, options, tenantDB);
      created.push(notif);
    } catch (err) {
      console.error(` Failed to send admin notification to ${adminId}:`, err.message);
    }
  }

  return created;
};

// ─────────────────────────────────────────────
// deleteNotificationsByEntity
// ─────────────────────────────────────────────
const buildEntityNotificationQuery = (entityType, entityId) => {
  const query = { $or: [] };
  const field =
    entityType === "deal"     ? "dealId"     :
    entityType === "lead"     ? "leadId"     :
    entityType === "proposal" ? "proposalId" : null;

  if (!field) return { $or: [] };

  const stringId = String(entityId);
  query.$or.push({ [`meta.${field}`]: stringId });
  query.$or.push({ referenceId: stringId });

  if (mongoose.Types.ObjectId.isValid(stringId)) {
    query.$or.push({ [`meta.${field}`]: new mongoose.Types.ObjectId(stringId) });
  }

  return query;
};

export const deleteNotificationsByEntity = async (
  entityType,
  entityId,
  userId   = null,
  tenantDB = null
) => {
  try {
    const { Notification } = resolveModels(tenantDB);
    const query = buildEntityNotificationQuery(entityType, entityId);

    if (userId) query.userId = userId;

    const notifications = await Notification.find(query).lean();
    const result        = await Notification.deleteMany(query);

    if (result.deletedCount > 0) {
      console.log(` Deleted ${result.deletedCount} notifications for ${entityType} ${entityId}`);
      if (userId) {
        const ids = notifications.map((n) => String(n._id));
        notifyUser(userId, "notification_deleted", { ids });
      }
    }
    return result;
  } catch (error) {
    console.error(` Error deleting notifications for ${entityType}:`, error);
    throw error;
  }
};

export const deleteAllNotificationsByEntity = async (
  entityType,
  entityId,
  tenantDB = null
) => {
  try {
    const { Notification } = resolveModels(tenantDB);
    const query = buildEntityNotificationQuery(entityType, entityId);

    const notifications = await Notification.find(query).lean();
    const result        = await Notification.deleteMany(query);

    if (result.deletedCount > 0) {
      console.log(` Deleted ${result.deletedCount} notifications for ${entityType} ${entityId} (all users)`);
      const deletionsByUser = new Map();
      notifications.forEach((notif) => {
        const userString = String(notif.userId);
        if (!deletionsByUser.has(userString)) deletionsByUser.set(userString, []);
        deletionsByUser.get(userString).push(String(notif._id));
      });
      for (const [uid, ids] of deletionsByUser.entries()) {
        notifyUser(uid, "notification_deleted", { ids });
      }
    }
    return result;
  } catch (error) {
    console.error(` Error deleting all notifications for ${entityType}:`, error);
    throw error;
  }
};
