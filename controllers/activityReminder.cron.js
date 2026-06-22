import cron         from "node-cron";
import Activity     from "../models/activity.models.js";
import Notification from "../models/notification.model.js";
import { notifyUser } from "../realtime/socket.js";
import User         from "../models/user.model.js";
import Role         from "../models/role.model.js";

const COOLDOWN_MS = 24 * 60 * 60 * 1000;

const getAdminUserIds = async () => {
  const adminRole = await Role.findOne({ name: "Admin" });
  if (!adminRole) return [];
  const admins = await User.find({ role: adminRole._id }, "_id");
  return admins.map((a) => a._id.toString());
};

const notificationExists = async (userId, activityId) => {
  const cutoff = new Date(Date.now() - COOLDOWN_MS);
  const existing = await Notification.findOne({
    userId,
    type:              "activity",
    "meta.activityId": activityId,
    createdAt:         { $gte: cutoff },
  });
  return !!existing;
};

const sendActivityNotification = async (userId, text, type, meta) => {
  const alreadySent = await notificationExists(userId, meta.activityId);
  if (alreadySent) return null;

  const notif = await Notification.create({
    userId, type, text, meta,
    expiresAt: new Date(Date.now() + COOLDOWN_MS),
  });

  notifyUser(userId, type === "activity" ? "activity_reminder" : "admin_reminder", {
    _id: notif._id, text: notif.text, type: notif.type,
    meta: notif.meta, createdAt: notif.createdAt,
  });

  return notif;
};

export function startActivityReminderCron() {
  cron.schedule("* * * * *", async () => {
    const now = new Date();
    const cooldownCutoff = new Date(now.getTime() - COOLDOWN_MS);

    console.log(" Activity Reminder Cron:", now.toISOString());

    try {
      const dueActivities = await Activity.find({
        reminder: { $exists: true, $ne: null, $lte: now },
        $or: [
          { lastReminderAt: { $exists: false } },
          { lastReminderAt: null },
          { lastReminderAt: { $lt: cooldownCutoff } },
        ],
      }).populate("assignedTo", "firstName lastName email _id");

      for (const act of dueActivities) {
        const userId     = act.assignedTo?._id?.toString();
        const activityId = act._id.toString();

        if (userId) {
          await sendActivityNotification(userId, ` Reminder for activity: "${act.title}"`, "activity", { activityId, startAt: act.startDate });
        }

        const admins = await getAdminUserIds();
        for (const adminId of admins) {
          await sendActivityNotification(adminId, `${act.assignedTo?.firstName || "Someone"} has activity: "${act.title}"`, "admin", { activityId, startAt: act.startDate });
        }

        // updateOne instead of act.save() — avoids any model validation errors
        await Activity.updateOne(
          { _id: act._id },
          { $set: { lastReminderAt: now } }
        );
      }

    } catch (err) {
      console.error(" Activity reminder cron error:", err.message);
    }
  });
}