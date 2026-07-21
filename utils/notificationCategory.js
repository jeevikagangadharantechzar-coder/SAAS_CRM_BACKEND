// Maps a Notification's `type` field to one of the CRM's notification categories.
// Kept as a single source of truth so category logic never drifts between call sites.

export const NOTIFICATION_CATEGORIES = {
  TASK: "task",
  TARGET: "target",
  LEAD: "lead",
  DEAL: "deal",
  FOLLOWUP: "followup",
  SCHEDULED_EMAIL: "scheduled_email",
  INVOICE: "invoice",
  OTHER: "other",
};

const TYPE_TO_CATEGORY = {
  task: NOTIFICATION_CATEGORIES.TASK,

  target: NOTIFICATION_CATEGORIES.TARGET,
  target_reminder: NOTIFICATION_CATEGORIES.TARGET,
  target_due_today: NOTIFICATION_CATEGORIES.TARGET,
  target_expired: NOTIFICATION_CATEGORIES.TARGET,
  target_reassign: NOTIFICATION_CATEGORIES.TARGET,
  reason_note: NOTIFICATION_CATEGORIES.TARGET,

  lead: NOTIFICATION_CATEGORIES.LEAD,

  deal: NOTIFICATION_CATEGORIES.DEAL,
  proposal: NOTIFICATION_CATEGORIES.DEAL,

  followup: NOTIFICATION_CATEGORIES.FOLLOWUP,

  scheduled_email: NOTIFICATION_CATEGORIES.SCHEDULED_EMAIL,

  invoice: NOTIFICATION_CATEGORIES.INVOICE,
};

export const getNotificationCategory = (type) =>
  TYPE_TO_CATEGORY[type] || NOTIFICATION_CATEGORIES.OTHER;

// Reverse lookup: category -> the list of `type` values belonging to it.
// Used to translate a `?category=` filter into a Mongo `type: { $in: [...] }` query.
export const getTypesForCategory = (category) =>
  Object.entries(TYPE_TO_CATEGORY)
    .filter(([, cat]) => cat === category)
    .map(([type]) => type);
