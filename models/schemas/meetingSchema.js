import mongoose from "mongoose";

const meetingSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    dealId: { type: mongoose.Schema.Types.ObjectId, ref: "Deal", default: null, index: true },
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
    creatorEmail: { type: String },
    reminderSentAt: { type: Date, default: null },
    // Who cancelled it and when — needed to show a proper attributed
    // "meeting cancelled" entry in the Deal Activity Log instead of it
    // silently disappearing from view.
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    cancelledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export default meetingSchema;
