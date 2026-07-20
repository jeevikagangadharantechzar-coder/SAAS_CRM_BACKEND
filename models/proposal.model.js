import mongoose from "mongoose";

const ProposalSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    createdBy:     { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    lastUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    deal: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Deal",
      required: false,
    },
    dealTitle: { type: String, required: true },
    email: { type: String, required: true },
    cc: { type: String },
    content: { type: String, required: false, default: "" },
    image: { type: String },
    value: { type: String, required: true },
    // currency: { type: String, required: true },
    companyName: { type: String },
    status: {
      type: String,
      enum: ["draft", "sent", "no reply", "rejection", "success"],
      default: "draft",
    },
    statusHistory: [
      {
        status:    { type: String, enum: ["draft", "sent", "no reply", "rejection", "success"] },
        changedAt: { type: Date, default: Date.now },
        changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      },
    ],

    followUpDate: { type: Date, default: Date.now }, // follow-up date
    followUpComment: { type: String, default: "" }, // comment

    lastReminderAt: { type: Date }, // avoid duplicate reminders
    
attachments: [
  {
    name: { 
      type: String, 
      required: true,
      get: function(v) {
        return v;
      },
      set: function(v) {
        return v;
      }
    },
    filename: { type: String },  // Add this for backward compatibility
    path: { type: String, required: true },
    type: { type: String },
    size: { type: Number },
    uploadedAt: { type: Date, default: Date.now },
  },
],
  },
  { timestamps: true }
);

const Proposal = mongoose.model("Proposal", ProposalSchema);

export default Proposal;
