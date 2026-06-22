import mongoose from "mongoose";

const activitySchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    startDate: { type: Date, required: true },
    endDate:   { type: Date, required: true },
    startTime: {
      type: String,
      required: true,
      match: /^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/,
    },
    endTime: {
      type: String,
      required: true,
      match: /^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/,
    },
    activityCategory: {
      type: String,
      required: true,
      enum: ["Call", "Meeting", "Email", "Task", "Deadline", "Other"],
    },
    reminder: { type: Date },
    deal: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Deal",
      required: true,
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    reminderSent:   { type: Boolean, default: false },
    lastReminderAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export default activitySchema;
