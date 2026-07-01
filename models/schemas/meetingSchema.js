import mongoose from "mongoose";

const meetingSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    startDateTime: { type: Date, required: true },
    endDateTime: { type: Date, required: true },
    attendees: [{ type: String, trim: true }],
    meetLink: { type: String },
    googleEventId: { type: String },
    reminderMinutes: { type: Number, default: 10 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    status: {
      type: String,
      enum: ["scheduled", "cancelled", "completed"],
      default: "scheduled",
    },
    creatorEmail: { type: String },
    reminderSentAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export default meetingSchema;
