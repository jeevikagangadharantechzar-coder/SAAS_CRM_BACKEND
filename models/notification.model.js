import mongoose from "mongoose";

const Notification = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
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
        "trial_reminder",
        "trial_expired",
        "scheduled_email",
      ],
      default: "followup",
    },
    title: { type: String, default: "Notification" },
    message: { type: String, required: true },
    text: { type: String, required: true },
    referenceId: { type: String, default: null },
    followUpDate: { type: Date, default: null },
    read: { type: Boolean, default: false },
    isRead: { type: Boolean, default: false },
    meta: { type: Object, default: {} },
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } }, // TTL Index - auto delete after expiresAt
    profileImage: { type: String, default: null },
  },
  { timestamps: true }
);

// TTL index for automatic deletion (redundant but ensures it's set)
Notification.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
Notification.index({ referenceId: 1 });
Notification.index({ userId: 1, type: 1, createdAt: -1 });

export default mongoose.model("Notification", Notification);
//originall






