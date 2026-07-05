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
