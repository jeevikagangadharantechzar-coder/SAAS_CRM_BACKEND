import mongoose from "mongoose";

const targetSchema = new mongoose.Schema(
  {
    salesPerson: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    period: {
      type: String,
      enum: ["weekly", "monthly"],
      required: true,
    },
    title: {
      type: String,
      required: true,
      default: "Untitled Target",
    },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    status: {
      type: String,
      enum: ["New", "In Progress", "In Hold", "Completed", "Rejected"],
      default: "New",
    },
    description: { type: String, default: "" },
    targetLeads: { type: Number, default: 0 },
    targetDeals: { type: Number, default: 0 },
    targetCalls: { type: Number, default: 0 },
    targetMeetings: { type: Number, default: 0 },
    linkedLeads: [{ type: mongoose.Schema.Types.ObjectId, ref: "Lead" }],
    linkedDeals: [{ type: mongoose.Schema.Types.ObjectId, ref: "Deal" }],
    notes: [
      {
        text:    { type: String, required: true },
        addedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        addedAt: { type: Date, default: Date.now },
      },
    ],
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    reasonNotes: [
      {
        itemType: { type: String, enum: ["lead", "deal", "target"] },
        itemId:   { type: mongoose.Schema.Types.ObjectId },
        itemName: { type: String },
        note:     { type: String, required: true },
        addedBy:  { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        addedAt:  { type: Date, default: Date.now },
        status:   { type: String, enum: ["pending", "resolved", "reactivated", "rejected"], default: "pending" },
        resolvedAt:    { type: Date },
        reassignedTo:  { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        reassignNote:  { type: String },
        rejectReason:  { type: String },
        // Snapshot details at time of report
        companyName:   { type: String },
        phoneNumber:   { type: String },
        email:         { type: String },
        value:         { type: String },
        currency:      { type: String },
        stageOrStatus: { type: String },
      },
    ],
    reportedCalls: [
      {
        companyName: { type: String, required: true },
        callSummary: { type: String, required: true },
        companyUrl:  { type: String },
        recordingUrl:{ type: String },
        addedBy:     { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        addedAt:     { type: Date, default: Date.now },
      }
    ],
    reportedMeetings: [
      {
        companyName:    { type: String, required: true },
        meetingSummary: { type: String, required: true },
        companyUrl:     { type: String },
        screenshotUrl:  { type: String },
        addedBy:        { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        addedAt:        { type: Date, default: Date.now },
      }
    ],
    reminderSentAt:   { type: Date, default: null },
    dueTodaySentAt:   { type: Date, default: null },
    expiredAt:        { type: Date, default: null },
    inProcessNote: { type: String, trim: true, default: "" },
    rejectionRequested: { type: Boolean, default: false },
    rejectionReason: { type: String, trim: true, default: "" },
    rejectionApprovedAt: { type: Date, default: null },
    
    holdRequested: { type: Boolean, default: false },
    holdReason: { type: String, trim: true, default: "" },
    holdRequestedAt: { type: Date, default: null },
    holdSnapshotProgress: { type: Number, default: null },
  },
  { timestamps: true }
);

export default targetSchema;
