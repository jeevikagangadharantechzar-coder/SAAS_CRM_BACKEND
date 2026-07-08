// Free-trial expiry notifications — kept separate from services/notificationService.js
// since these are tenant-lifecycle events (not lead/deal/proposal follow-ups) and use
// their own dedicated socket channel (realtime/freeTrialSocket.js).
import moment from "moment";
import { getTenantModels } from "../models/tenant/index.js";
import { notifyUser } from "../realtime/socket.js";
import { notifyTrialUser } from "../realtime/freeTrialSocket.js";
import { formatExpiryDate } from "../utils/trialDate.util.js";

// Kept short on purpose — the exact expiry date is shown as its own element
// in the UI (banner pill / modal line) via meta.expiryDate, not crammed into
// this sentence, so the message never gets cut off in the banner.
const REMINDER_COPY = {
  7: "Your 14-day free trial has one week left. You're off to a great start — upgrade now to keep everything running without interruption.",
  3: "Just 3 days remain on your free trial. Upgrade today so your team doesn't lose access to your data and workflow.",
  1: "Your free trial ends tomorrow. Upgrade now to keep your CRM active — it only takes a minute.",
};

const EXPIRED_COPY = "Your 14-day free trial has ended. Upgrade your plan to continue using the CRM.";

const getAdminUserIds = async (tenantDB) => {
  try {
    const { Role, User } = getTenantModels(tenantDB);
    const adminRole = await Role.findOne({ name: { $regex: /^admin$/i } }).lean();
    if (!adminRole) return [];
    const admins = await User.find({ role: adminRole._id, status: "Active" }).select("_id").lean();
    return admins.map((u) => String(u._id));
  } catch (err) {
    console.error("freeTrialNotification: failed to fetch admin users:", err.message);
    return [];
  }
};

const createAndEmit = async (userId, tenantDB, { type, title, text, meta }) => {
  const { Notification } = getTenantModels(tenantDB);

  const notif = await Notification.create({
    userId,
    type,
    title,
    message: text,
    text,
    meta,
    read: false,
    isRead: false,
    expiresAt: moment().add(30, "days").toDate(),
  });

  const payload = {
    id: notif._id,
    title: notif.title,
    message: notif.message,
    text: notif.text,
    type: notif.type,
    meta: notif.meta,
    createdAt: notif.createdAt,
    isRead: notif.isRead,
  };

  // Generic bell feed
  notifyUser(userId, "new_notification", payload);
  // Dedicated free-trial channel (drives the CRM-wide banner/modal)
  notifyTrialUser(userId, type, payload);

  return notif;
};

/** Sends a 7/3/1-day-before-expiry reminder to every admin of the tenant. */
export const sendTrialReminder = async (tenant, daysLeft, tenantDB) => {
  const message = REMINDER_COPY[daysLeft];
  if (!message) return [];

  const expiryDate = formatExpiryDate(tenant.plan_end_date);
  const adminIds = await getAdminUserIds(tenantDB);
  const created = [];

  for (const adminId of adminIds) {
    try {
      const notif = await createAndEmit(adminId, tenantDB, {
        type: "trial_reminder",
        title: `${daysLeft} Day${daysLeft === 1 ? "" : "s"} Left in Your Free Trial`,
        text: message,
        meta: { daysLeft, expiryDate, tenantSlug: tenant.slug },
      });
      created.push(notif);
    } catch (err) {
      console.error(`sendTrialReminder failed for tenant ${tenant.slug}, user ${adminId}:`, err.message);
    }
  }

  return created;
};

/** Sends a one-time "trial has ended" notice to every admin of the tenant. */
export const sendTrialExpiredNotification = async (tenant, tenantDB) => {
  const expiryDate = formatExpiryDate(tenant.plan_end_date);
  const adminIds = await getAdminUserIds(tenantDB);
  const created = [];

  for (const adminId of adminIds) {
    try {
      const notif = await createAndEmit(adminId, tenantDB, {
        type: "trial_expired",
        title: "Your Free Trial Has Ended",
        text: EXPIRED_COPY,
        meta: { expiryDate, tenantSlug: tenant.slug },
      });
      created.push(notif);
    } catch (err) {
      console.error(`sendTrialExpiredNotification failed for tenant ${tenant.slug}, user ${adminId}:`, err.message);
    }
  }

  return created;
};
