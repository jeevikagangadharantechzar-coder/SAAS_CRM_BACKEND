import mongoose from "mongoose";

const ProposalSchema = new mongoose.Schema(
  {
    title:    { type: String, required: true },
    deal:     { type: mongoose.Schema.Types.ObjectId, ref: "Deal", required: false },
    dealTitle:{ type: String, required: true },
    createdBy:    { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    lastUpdatedBy:{ type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    email:    { type: String, required: true },
    cc:       { type: String },
    content:  { type: String, required: false, default: "" },
    image:    { type: String },
    value:    { type: String, required: true },
    companyName: { type: String },
    status: {
      type: String,
      enum: ["draft", "sent", "no reply", "rejection", "success"],
      default: "draft",
    },
    // Every status transition, oldest first — status alone only ever shows
    // the current value, so without this a proposal that went
    // draft → success → no reply → sent would show only "sent" in the
    // Activity Log, with every earlier transition silently lost.
    statusHistory: [
      {
        status:    { type: String, enum: ["draft", "sent", "no reply", "rejection", "success"] },
        changedAt: { type: Date, default: Date.now },
        changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      },
    ],
    followUpDate:    { type: Date, default: Date.now },
    followUpComment: { type: String, default: "" },
    lastReminderAt:  { type: Date },
    attachments: [
      {
        name: {
          type: String,
          required: true,
          get: function (v) { return v; },
          set: function (v) { return v; },
        },
        filename:   { type: String },
        path:       { type: String, required: true },
        type:       { type: String },
        size:       { type: Number },
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

export default ProposalSchema;
