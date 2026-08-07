import mongoose from "mongoose";
import { notifyUser } from "../../realtime/socket.js";

const leadSchema = new mongoose.Schema(
  {
    leadName:    { type: String, required: true },
    phoneNumber: { type: String, required: true },
    email:       { type: String },
    alternatePhoneNumber: { type: String },
    alternateEmail:       { type: String },
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
    NumberOfEmployees: { type: Number },


    assignTo: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    // Who last touched a plain field (name/phone/company/etc.), and when —
    // same idea as notesUpdatedBy, just for everything else. Only stamped
    // when a plain field actually changes, not on saves that only touch
    // status/assignTo/notes/attachments (those already have their own
    // attributed history below).
    lastUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    lastUpdatedAt: { type: Date, default: null },

    // Reassignment history — mirrors Deal's assignmentHistory. Only records
    // actual changes via updateLead, not the initial assignment at creation
    // (that's already implicit in the "Lead created" event itself).
    assignmentHistory: [
      {
        assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        assignedAt: { type: Date, default: Date.now },
      },
    ],

    // False while the item is overdue on an expired Target and awaiting admin
    // reassignment — the owning sales person keeps seeing it (read-only) until
    // it's reassigned back to them or someone else.
    isActive: { type: Boolean, default: true },

    address: { type: String },
    city: { type: String },
    state: { type: String },
    pincode: { type: String },
    country: { type: String },
    latitude: { type: Number },
    longitude: { type: Number },

    status: {
      type: String,
      enum: ["Hot", "Warm", "Cold", "Junk", "Converted", "Rejected"],
      default: "Cold",
    },
    rejectionReason: { type: String, default: "" },
    rejectedBy:       { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    rejectedAt:       { type: Date, default: null },

    // Admin-only soft-hide: trashed leads are excluded from getAllLead but
    // never deleted, so the record stays intact for anyone querying the DB directly.
    // trashedAt anchors the 30-day auto-purge window (cron/trashCron.js).
    trash:     { type: Boolean, default: false },
    trashedAt: { type: Date, default: null },

    // Who actually performed the lead→deal conversion — only set when the
    // converted lead keeps a read-only copy here (currently: admin conversions).
    convertedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    // Hides this lead from the Task Management / Target Management "Admin
    // Completed" activity feeds once Admin dismisses it there — purely a
    // feed-declutter flag, the lead record itself (and its Converted status)
    // is untouched. Two independent flags so dismissing from one feed never
    // hides the item from the other — a lead can legitimately be linked to
    // both a Task and a Target at once.
    taskAdminActivityDismissed: { type: Boolean, default: false },
    targetAdminActivityDismissed: { type: Boolean, default: false },

    followUpDate:    { type: Date, default: Date.now },
    emailSentAt:     { type: Date, default: null },
    lastReminderAt:  { type: Date, default: null },

    notes: { type: String },
    // Latest-edit snapshot — kept as-is since other UI already reads it
    // directly (e.g. a "notes last updated by X" preview card).
    notesUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    notesUpdatedAt: { type: Date, default: null },
    // Full history alongside the snapshot above — notesUpdatedBy/At only
    // ever holds the MOST RECENT change (overwritten every save), so the
    // Activity Timeline needs its own append-only record to show every
    // occasion notes were touched, not just the latest one.
    notesHistory: [
      {
        changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        changedAt: { type: Date, default: Date.now },
      },
    ],

    followUpNotes: [
      {
        note:      { type: String, required: true },
        audioPath: { type: String, default: null },
        audioName: { type: String, default: null },
        createdAt: { type: Date, default: Date.now },
      },
    ],

    // Audit trail of add/edit/delete actions on followUpNotes, kept even after
    // the underlying note is deleted so the timeline stays intact.
    followUpNotesHistory: [
      {
        action:      { type: String, enum: ["added", "edited", "deleted"], required: true },
        note:        { type: String, default: "" },
        performedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        createdAt:   { type: Date, default: Date.now },
      },
    ],

    // Meta (Facebook / Instagram) lead capture metadata
    meta: {
      leadgenId: { type: String, default: null, index: true },  // Facebook leadgen_id (for dedup)
      pageId:    { type: String, default: null },
      formId:    { type: String, default: null },
      rawFields: { type: Map, of: String, default: {} },        // all form fields as-is
    },

    // Instagram DM lead source
    instagramUsername: { type: String, default: null, index: true },

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
        uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      },
    ],

    images: [
      {
        name:       { type: String, default: "" },
        path:       { type: String, default: "" },
        type:       { type: String, default: "application/octet-stream" },
        size:       { type: Number, default: 0 },
        uploadedAt: { type: Date, default: Date.now },
        uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      },
    ],

    statusHistory: [
      {
        status:    { type: String },
        changedAt: { type: Date, default: Date.now },
        changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      },
    ],

    // Every plain follow-up date reschedule (list-page quick edit or the
    // edit form) — separate from followUpNotesHistory, which is about the
    // note text rather than the date itself.
    followUpDateHistory: [
      {
        oldDate:   { type: Date, default: null },
        newDate:   { type: Date },
        changedAt: { type: Date, default: Date.now },
        changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      },
    ],

    // User-defined fields added via the "+ Add Field" button on the Create/Edit
    // Lead form. cardTitle ties each field back to the section it was added
    // from (Basic Information, Business Details, etc.) so the form can
    // re-render it in the right card on edit.
    customFields: [
      {
        cardTitle: { type: String, default: "" },
        name:      { type: String, required: true },
        type: {
          type: String,
          enum: ["text", "number", "date", "textarea", "dropdown"],
          default: "text",
        },
        options: [{ type: String }],
        value:   { type: String, default: "" },
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
