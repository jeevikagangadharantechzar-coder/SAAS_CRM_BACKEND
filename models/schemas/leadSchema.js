import mongoose from "mongoose";
import { notifyUser } from "../../realtime/socket.js";

const leadSchema = new mongoose.Schema(
  {
    leadName:    { type: String, required: true },
    phoneNumber: { type: String, required: true },
    email:       { type: String },
    source:      { type: String },
    sourceId:    { type: String, default: null, index: true },
    companyName: { type: String, required: true },
    clientType: {
      type: String,
      enum: ["B2B", "B2C"],
      trim: true,
    },
    industry:    { type: String },
    requirement: { type: String },

    assignTo: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    // False while the item is overdue on an expired Target and awaiting admin
    // reassignment — the owning sales person keeps seeing it (read-only) until
    // it's reassigned back to them or someone else.
    isActive: { type: Boolean, default: true },

    address: { type: String },
    country: { type: String },

    status: {
      type: String,
      enum: ["Hot", "Warm", "Cold", "Junk", "Converted", "Rejected"],
      default: "Cold",
    },
    rejectionReason: { type: String, default: "" },
    rejectedBy:       { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    rejectedAt:       { type: Date, default: null },

    // Who actually performed the lead→deal conversion — only set when the
    // converted lead keeps a read-only copy here (currently: admin conversions).
    convertedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    followUpDate:    { type: Date, default: Date.now },
    emailSentAt:     { type: Date, default: null },
    lastReminderAt:  { type: Date, default: null },

    notes: { type: String },

    // Meta (Facebook / Instagram) lead capture metadata
    meta: {
      leadgenId: { type: String, default: null, index: true },  // Facebook leadgen_id (for dedup)
      pageId:    { type: String, default: null },
      formId:    { type: String, default: null },
      rawFields: { type: Map, of: String, default: {} },        // all form fields as-is
    },

    // LinkedIn lead capture metadata
    linkedinLeadId:       { type: String, default: null, index: true },
    linkedinCampaignId:   { type: String, default: null },
    linkedinCampaignName: { type: String, default: null },
    linkedinFormId:       { type: String, default: null },
    linkedinFormName:     { type: String, default: null },

    attachments: [
      {
        name:       { type: String, required: true },
        path:       { type: String, required: true },
        type:       { type: String },
        size:       { type: Number },
        uploadedAt: { type: Date, default: Date.now },
      },
    ],

    statusHistory: [
      {
        status:    { type: String },
        changedAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

leadSchema.index({ followUpDate: 1 });
leadSchema.index({ status: 1, lastReminderAt: 1 });

// Cascade-delete notifications when a lead is hard-deleted (query hook)
leadSchema.post("findOneAndDelete", async function (doc) {
  if (!doc) return;
  try {
    const NotificationModel = this.model.db.model("Notification");
    const deletedNotifications = await NotificationModel.find({
      "meta.leadId": doc._id.toString(),
    }).lean();

    await NotificationModel.deleteMany({ "meta.leadId": doc._id.toString() });

    const map = new Map();
    deletedNotifications.forEach((n) => {
      if (!map.has(n.userId)) map.set(n.userId, []);
      map.get(n.userId).push(n._id.toString());
    });

    for (const [userId, ids] of map.entries()) {
      notifyUser(userId, "notification_deleted", { ids });
    }
  } catch (err) {
    console.error("Lead cascade-delete notification error:", err.message);
  }
});

leadSchema.post("deleteOne", { document: true, query: false }, async function () {
  const leadId = this._id.toString();
  try {
    const NotificationModel = this.constructor.db.model("Notification");
    const deletedNotifications = await NotificationModel.find({
      "meta.leadId": leadId,
    }).lean();

    await NotificationModel.deleteMany({ "meta.leadId": leadId });

    const map = new Map();
    deletedNotifications.forEach((n) => {
      if (!map.has(n.userId)) map.set(n.userId, []);
      map.get(n.userId).push(n._id.toString());
    });

    for (const [userId, ids] of map.entries()) {
      notifyUser(userId, "notification_deleted", { ids });
    }
  } catch (err) {
    console.error("Lead deleteOne notification error:", err.message);
  }
});

export default leadSchema;
