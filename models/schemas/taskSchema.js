import mongoose from "mongoose";

const taskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    priority: {
      type: String,
      enum: ["Low", "Medium", "High", "Urgent"],
      default: "Medium",
    },
    status: {
      type: String,
      enum: ["Pending", "In Progress", "Completed"],
      default: "Pending",
    },
    dueDate: { type: Date, required: true },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    leadRef: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", default: null },
    dealRef: { type: mongoose.Schema.Types.ObjectId, ref: "Deal", default: null },
    // Full multi-link history — leadRef/dealRef above are kept in sync as a
    // derived "primary" pointer (the most-recently-linked item, i.e. the
    // last array element) so every existing reader of the singular fields
    // (Progress Card computation, cron reminders, notification badges)
    // keeps working unchanged. New links are always pushed to the end;
    // removal is only ever an explicit action, never a side effect of
    // adding something else.
    leadRefs: [{ type: mongoose.Schema.Types.ObjectId, ref: "Lead" }],
    dealRefs: [{ type: mongoose.Schema.Types.ObjectId, ref: "Deal" }],
    // Per-item due date, keyed by lead/deal id (as a string) — set only when
    // that lead/deal is newly linked during an edit, so each addition can
    // carry its own deadline independent of the task's own dueDate above.
    // Kept as a separate Map rather than folded into leadRefs/dealRefs so
    // every existing reader of those as plain ObjectId arrays (Progress
    // Card, cron, linkageService, notifications) keeps working unchanged.
    leadDueDates: { type: Map, of: Date, default: {} },
    dealDueDates: { type: Map, of: Date, default: {} },
    // One-shot guards for the per-lead/deal due-date reminder cron, same
    // one-shot idea as reminderSentAt/dueTodaySentAt below but keyed by
    // lead/deal id since a task can have several, each with its own
    // deadline. A newly-linked item starts with no entry here, so it's
    // always eligible to fire once its own due date approaches.
    leadDueReminderSentAt: { type: Map, of: Date, default: {} },
    leadDueTodaySentAt: { type: Map, of: Date, default: {} },
    dealDueReminderSentAt: { type: Map, of: Date, default: {} },
    dealDueTodaySentAt: { type: Map, of: Date, default: {} },
    callsMade: { type: Number, default: 0, min: 0 },
    meetingsDone: { type: Number, default: 0, min: 0 },
    completionNotes: { type: String, trim: true, default: "" },
    approvedByAdmin: { type: Boolean, default: false },
    completedAt:     { type: Date, default: null },

    // "Delete" from the admin's list never erases the record — it just hides
    // it here, keeping history/audit trail intact in the database. Applies
    // to BOTH admin's and the sales person's own list.
    archived: { type: Boolean, default: false },

    // Detailed tracking journey — every event on the task's life, for both
    // admin and the sales person to see (created, assigned, status changes,
    // notes, reassignment, completion, approval).
    history: [
      {
        event:  { type: String, required: true },
        detail: { type: String, default: "" },
        by:     { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        at:     { type: Date, default: Date.now },
      },
    ],

    // One-shot guards for the due-date reminder cron — reset to null whenever
    // the task is reassigned or its due date changes, so reminders fire again.
    reminderSentAt: { type: Date, default: null },
    dueTodaySentAt: { type: Date, default: null },

    // Sales person reports the task as stuck/delayed — same reason-notes
    // pattern as Target Management, scoped to this single task.
    reasonNotes: [
      {
        note:         { type: String, required: true },
        addedBy:      { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        addedAt:      { type: Date, default: Date.now },
        status:       { type: String, enum: ["pending", "resolved", "reactivated"], default: "pending" },
        resolvedAt:   { type: Date },
        reassignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        reassignNote: { type: String },
      },
    ],
  },
  { timestamps: true }
);

export default taskSchema;