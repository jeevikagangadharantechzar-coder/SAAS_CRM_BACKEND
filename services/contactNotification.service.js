import NotificationLegacy from "../models/notification.model.js";
import UserLegacy from "../models/user.model.js";
import RoleLegacy from "../models/role.model.js";
import { notifyUser } from "../realtime/socket.js";
import { getTenantModels } from "../models/tenant/index.js";
import { getTenantDB } from "../config/tenantDB.js";

export const sendContactFormNotification = async ({ tenant, text, meta }) => {
  let Notification = NotificationLegacy;
  let User = UserLegacy;
  let Role = RoleLegacy;

  if (tenant && tenant.dbName) {
    const conn = await getTenantDB(tenant.dbName);
    const tenantModels = getTenantModels(conn);
    Notification = tenantModels.Notification;
    User = tenantModels.User;
    Role = tenantModels.Role;
  }

  const adminRole = await Role.findOne({ name: { $regex: /^admin$/i } });
  if (!adminRole) {
    console.log(" Admin role not found");
    return []; 
  }

  const users = await User.find({ role: adminRole._id }).select("_id profileImage");
  if (!users.length) {
    console.log(" No users found for admin role");
    return [];
  }

  const notifications = [];

  for (const user of users) {
    try {
      console.log(" Sending notification to user:", user._id.toString());

      const notif = await Notification.create({
        userId: user._id,
        title: "Website Contact Form",
        message: text || "New website contact form submitted",
        text: text || "New website contact form submitted",
        type: "contact_form",
        meta,
        profileImage: user.profileImage || null,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      try {
        notifyUser(user._id, "new_notification", {
          id: notif._id,
          title: notif.title,
          text: notif.text,
          message: notif.message,
          type: notif.type,
          meta: notif.meta,
          profileImage: notif.profileImage,
          createdAt: notif.createdAt,
        });
      } catch (socketErr) {
        console.log(" Socket notify failed for user:", user._id, socketErr);
      }

      notifications.push(notif);
    } catch (err) {
      console.log(" Failed to send notification for user:", user._id, err);
    }
  }

  return notifications;
};
