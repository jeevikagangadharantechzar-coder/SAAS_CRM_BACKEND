import mongoose from "mongoose";

const dealSchema = new mongoose.Schema({
  leadId:       { type: mongoose.Schema.Types.ObjectId, ref: "Lead" },
  dealTitle:    { type: String },
  dealName:     { type: String, required: true },
  assignedTo:   { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  // False while the item is overdue on an expired Target and awaiting admin
  // reassignment — the owning sales person keeps seeing it (read-only) until
  // it's reassigned back to them or someone else.
  isActive:     { type: Boolean, default: true },
  value:        { type: String, required: true },
  currency:     { type: String, default: "INR" },
  clientType: {
    type: String,
    enum: ["B2B", "B2C"],
    trim: true,
  },
  discountGiven: { type: Number, default: 0, min: 0, max: 100 },
  stage: {
    type: String,
    enum: [
      "Qualification",
      "Proposal Sent-Negotiation",
      "Invoice Sent",
      "Closed Won",
      "Closed Lost",
      "Rejected",
    ],
    default: "Qualification",
  },
  rejectionReason: { type: String, default: "" },
  rejectedBy:       { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  rejectedAt:       { type: Date, default: null },
  convertedAt:      { type: Date, default: null },
  notes:            { type: String },
  phoneNumber:      { type: String },
  email:            { type: String },
  source:           { type: String },
  companyName:      { type: String },
  companyId:        { type: mongoose.Schema.Types.ObjectId, ref: "Company" },
  companySize: {
    type: String,
    enum: ["Small", "Medium", "Large", "Enterprise"],
    default: "Medium",
  },
  industry:         { type: String },
  requirement:      { type: String },
  address:          { type: String },
  country:          { type: String },
  attachments: [
    {
      name:       { type: String, default: "" },
      path:       { type: String, default: "" },
      type:       { type: String, default: "application/octet-stream" },
      size:       { type: Number, default: 0 },
      uploadedAt: { type: Date, default: Date.now },
    },
  ],
  lossReason:    { type: String, default: "" },
  lossNotes:     { type: String, default: "" },
  stageLostAt:   { type: String, default: null },
  lostDate:      { type: Date, default: null },
  wonAt:         { type: Date },
  stageHistory: [
    {
      stage:   { type: String },
      movedAt: { type: Date, default: Date.now },
      movedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    },
  ],
  wonBy:         { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  convertedBy:   { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  // Hides this deal from the Task Management / Target Management "Admin
  // Completed" activity feeds once Admin dismisses it there — purely a
  // feed-declutter flag, the deal record itself is untouched. Two independent
  // flags so dismissing from one feed never hides the item from the other —
  // a deal can legitimately be linked to both a Task and a Target at once.
  taskAdminActivityDismissed: { type: Boolean, default: false },
  targetAdminActivityDismissed: { type: Boolean, default: false },
  leadStatusHistory: [{ status: { type: String }, changedAt: { type: Date } }],
  leadCreatedAt: { type: Date, default: null },
  clientReviewId:{ type: mongoose.Schema.Types.ObjectId, ref: "ClientReview" },
  followUpDate:  { type: Date, default: null },
  followUpComment: { type: String, default: "" },
  followUpHistory: [
    {
      date:           { type: Date, default: Date.now },
      followUpDate:   { type: Date },
      followUpComment:{ type: String },
      changedBy:      { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      action: {
        type: String,
        enum: ["Created", "Updated", "Completed", "Cancelled", "Rescheduled", "Scheduled"],
      },
    },
  ],
  createdAt:     { type: Date, default: Date.now },
  updatedAt:     { type: Date, default: Date.now },
  lastReminderAt:{ type: Date, default: null },
});

dealSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  if (this.isNew && this.stage === "Qualification" && !this.convertedAt) {
    this.convertedAt = new Date();
  }
  next();
});

dealSchema.index({ companyName: 1 });
dealSchema.index({ companyId: 1 });
dealSchema.index({ stage: 1 });
dealSchema.index({ industry: 1 });
dealSchema.index({ followUpDate: 1 });
dealSchema.index({ lastReminderAt: 1 });
dealSchema.index({ wonAt: 1 });
dealSchema.index({ createdAt: -1 });

export default dealSchema;
