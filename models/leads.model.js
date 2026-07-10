import mongoose from "mongoose";
import Notification from "./notification.model.js"; 

const leadSchema = new mongoose.Schema(
  {
    leadName: { type: String, required: true },
    phoneNumber: { type: String, required: true },
    email: { type: String },
    source: { type: String },
    companyName: { type: String, required: true },
    clientType: {
      type: String,
      enum: ["B2B", "B2C"],
      default: null,
    },
    industry: { type: String },
    requirement: { type: String },

    assignTo: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    address: { type: String },
    country: { type: String },

    status: {
      type: String,
      enum: ["Hot", "Warm", "Cold", "Junk", "Converted"],
      default: "Cold",
    },

    // Create date same follow up date
    followUpDate: { type: Date, default: Date.now },

    emailSentAt: { type: Date, default: null },
    lastReminderAt: { type: Date, default: null },

    notes: { type: String },
    notesUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    notesUpdatedAt: { type: Date, default: null },
    followUpNotes: [
      {
        note:      { type: String, required: true },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    attachments: [
      {
        name: { type: String, required: true },
        path: { type: String, required: true },
        type: { type: String },
        size: { type: Number },
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

leadSchema.index({ followUpDate: 1 });
leadSchema.index({ status: 1, lastReminderAt: 1 }); // speeds up cron query

// Cascade-delete notifications when a lead is hard-deleted
leadSchema.post("findOneAndDelete", async function (doc) {
  if (!doc) return;

  const deletedNotifications = await Notification.find({
    "meta.leadId": doc._id.toString(),
  }).lean();

  await Notification.deleteMany({ "meta.leadId": doc._id.toString() });

  const map = new Map();
  deletedNotifications.forEach((n) => {
    if (!map.has(n.userId)) map.set(n.userId, []);
    map.get(n.userId).push(n._id.toString());
  });

  for (const [userId, ids] of map.entries()) {
    notifyUser(userId, "notification_deleted", { ids });
  }
});

leadSchema.post("deleteOne", { document: true, query: false }, async function () {
  const leadId = this._id.toString();

  const deletedNotifications = await Notification.find({
    "meta.leadId": leadId,
  }).lean();

  await Notification.deleteMany({ "meta.leadId": leadId });

  const map = new Map();
  deletedNotifications.forEach((n) => {
    if (!map.has(n.userId)) map.set(n.userId, []);
    map.get(n.userId).push(n._id.toString());
  });

  for (const [userId, ids] of map.entries()) {
    notifyUser(userId, "notification_deleted", { ids });
  }
});

const Lead = mongoose.model("Lead", leadSchema);
export default Lead;
