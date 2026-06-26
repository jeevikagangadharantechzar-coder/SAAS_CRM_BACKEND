import mongoose from "mongoose";

const taskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    priority: {
      type: String,
      enum: ["Low", "Medium", "High", "Urgent"],
      default: "Medium",
    },
    status: {
      type: String,
      enum: ["Pending", "In Progress", "Completed"],
      default: "Pending",
    },
    dueDate: { type: Date, required: true },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    leadRef: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", default: null },
    dealRef: { type: mongoose.Schema.Types.ObjectId, ref: "Deal", default: null },
    completionNotes: { type: String, trim: true, default: "" },
    approvedByAdmin: { type: Boolean, default: false },
    completedAt:     { type: Date, default: null },
  },
  { timestamps: true }
);

export default taskSchema;
