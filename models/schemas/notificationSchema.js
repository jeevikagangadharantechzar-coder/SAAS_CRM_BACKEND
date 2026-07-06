import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema(
  {
    userId:    { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    type: {
      type: String,
      enum: [
        "lead",
        "deal",
        "proposal",
        "contact_form",
        "activity",
        "admin",
        "activity_reminder",
        "followup",
        "task",
        "target",
        "reason_note",
        "target_reassign",
        "target_reminder",
        "target_due_today",
        "target_expired",
      ],
      default: "followup",
    },
    title:       { type: String, default: "Notification" },
    message:     { type: String, required: true },
    text:        { type: String, required: true },
    referenceId: { type: String, default: null },
    followUpDate:{ type: Date, default: null },
    read:        { type: Boolean, default: false },
    isRead:      { type: Boolean, default: false },
    meta:        { type: Object, default: {} },
    expiresAt:   { type: Date, required: true, index: { expireAfterSeconds: 0 } },
    profileImage:{ type: String, default: null },
  },
  { timestamps: true }
);

notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
notificationSchema.index({ referenceId: 1 });
notificationSchema.index({ userId: 1, type: 1, createdAt: -1 });

export default notificationSchema;
