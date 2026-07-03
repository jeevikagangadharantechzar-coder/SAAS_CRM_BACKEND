import mongoose from "mongoose";

const meetingSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    startDateTime: { type: Date, required: true },
    endDateTime: { type: Date, required: true },
    attendees: [{ type: String, trim: true }],
    provider: {
      type: String,
      enum: ["google_meet", "zoom"],
      default: "google_meet",
    },
    meetLink: { type: String },
    googleEventId: { type: String },
    zoomMeetingId: { type: String },
    zoomStartUrl: { type: String },
    zoomPassword: { type: String },
    reminderMinutes: { type: Number, default: 10 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    status: {
      type: String,
      enum: ["scheduled", "cancelled", "completed"],
      default: "scheduled",
    },
  },
  { timestamps: true }
);

export default meetingSchema;
