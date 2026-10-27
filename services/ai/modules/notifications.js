import { has, matchesWord, formatDateTime, plural } from "../helpers.js";

const TYPE_WORDS = {
  lead: "lead", deal: "deal", task: "task", target: "target|target_reminder|target_due_today|target_expired|target_reassign",
  invoice: "invoice", proposal: "proposal", followup: "followup", reminder: "activity_reminder|followup",
};

// Always the asking user's own notifications.
export default {
  name: "notifications",

  match: ({ lower }) => matchesWord(lower, "notifications?|alerts?"),

  handle: async (ctx) => {
    const { Notification } = ctx.models;
    if (!Notification) return null;

    const { lower, dateFilter, dateLabel, userId } = ctx;
    const unreadOnly = !matchesWord(lower, "all|read");
    const query = { userId, ...(dateFilter && { createdAt: dateFilter }) };
    if (unreadOnly) { query.isRead = { $ne: true }; query.read = { $ne: true }; }
    else if (matchesWord(lower, "read") && !has(lower, "unread")) query.$or = [{ isRead: true }, { read: true }];

    const typeKey = Object.keys(TYPE_WORDS).find((k) => matchesWord(lower, `${k}s?`) && k !== "followup");
    if (typeKey) query.type = { $in: TYPE_WORDS[typeKey].split("|") };

    const [count, notifications] = await Promise.all([
      Notification.countDocuments(query),
      Notification.find(query).sort({ createdAt: -1 }).limit(30),
    ]);

    const label = `${unreadOnly ? "unread " : ""}${typeKey ? `${typeKey} ` : ""}notification`;
    return {
      intent: `notifications${unreadOnly ? "-unread" : ""}`,
      message: count ? `You have ${plural(count, label)}${dateLabel}.${count > 30 ? " Showing the latest 30." : ""}` : `You have no ${label}s${dateLabel}.`,
      data: notifications.map((n) => ({
        _id: n._id,
        type: "notification",
        name: n.title || "Notification",
        status: n.isRead || n.read ? "Read" : "Unread",
        detail: `${(n.message || n.text || "").slice(0, 100)} · ${formatDateTime(n.createdAt)}`,
        handledBy: null,
        createdAt: n.createdAt,
      })),
    };
  },
};
