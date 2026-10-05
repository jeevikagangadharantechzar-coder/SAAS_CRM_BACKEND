import mongoose from "mongoose";

const commentSchema = new mongoose.Schema({
  by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  role: String,
  text: String,
  at: { type: Date, default: Date.now },
});

const externalDocumentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    path: { type: String, required: true },
    type: { type: String, default: "application/octet-stream" },
    size: { type: Number, default: 0 },
    
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    
    status: {
      type: String,
      enum: ["Assigned", "Viewed", "Replied", "Approved", "Rejected"],
      default: "Assigned",
    },
    comments: [commentSchema],
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

export default externalDocumentSchema;
