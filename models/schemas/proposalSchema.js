import mongoose from "mongoose";

const ProposalSchema = new mongoose.Schema(
  {
    title:    { type: String, required: true },
    deal:     { type: mongoose.Schema.Types.ObjectId, ref: "Deal", required: false },
    dealTitle:{ type: String, required: true },
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
