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
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
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
        itemType: { type: String, enum: ["lead", "deal"] },
        itemId:   { type: mongoose.Schema.Types.ObjectId },
        itemName: { type: String },
        note:     { type: String, required: true },
        addedBy:  { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        addedAt:  { type: Date, default: Date.now },
        status:   { type: String, enum: ["pending", "resolved", "reactivated"], default: "pending" },
        resolvedAt:    { type: Date },
        reassignedTo:  { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        reassignNote:  { type: String },
        // Snapshot details at time of report
        companyName:   { type: String },
        phoneNumber:   { type: String },
        email:         { type: String },
        value:         { type: String },
        currency:      { type: String },
        stageOrStatus: { type: String },
      },
    ],
    reminderSentAt:   { type: Date, default: null },
    dueTodaySentAt:   { type: Date, default: null },
    expiredAt:        { type: Date, default: null },
  },
  { timestamps: true }
);

export default targetSchema;
