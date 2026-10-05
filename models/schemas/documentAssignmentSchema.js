import mongoose from "mongoose";

const documentAssignmentSchema = new mongoose.Schema({
  sourceType: {
    type: String,
    enum: ["Lead", "Deal", "External", "Invoice"],
    required: true,
  },
  sourceId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  documentId: {
    type: mongoose.Schema.Types.ObjectId,
    required: false,
  },
  documentName: { type: String },
  documentPath: { type: String },
  documentType: { type: String },
  documentSize: { type: Number },
  sourceName:   { type: String },
  
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  assignedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  note: {
    type: String,
    default: "",
  },
  status: {
    type: String,
    enum: ["Assigned", "Viewed", "Replied", "Approved", "Rejected", "Sent"],
    default: "Assigned",
  },
  activity: [
    {
      action: { type: String }, // e.g., "Assigned", "Viewed", "Replied", "Approved", "Rejected", "Commented"
      performedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      role: { type: String },
      note: { type: String },
      createdAt: { type: Date, default: Date.now },
    },
  ],
  deletedAt: {
    type: Date,
    default: null,
  },
}, { timestamps: true });

documentAssignmentSchema.index({ assignedTo: 1, deletedAt: 1 });
documentAssignmentSchema.index({ sourceType: 1, sourceId: 1, documentId: 1 });

export default documentAssignmentSchema;
