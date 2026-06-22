import mongoose from "mongoose";

const botHistorySchema = new mongoose.Schema(
  {
    userId:      { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    command:     { type: String },
    searchTerm:  { type: String },
    action:      { type: String, enum: ["search", "call", "suggestion"], default: "search" },
    contactId:   { type: mongoose.Schema.Types.ObjectId },
    contactType: { type: String, enum: ["lead", "deal", null] },
    matchCount:  { type: Number, default: 0 },
    sessionId:   { type: String },
  },
  { timestamps: true }
);

export default botHistorySchema;
