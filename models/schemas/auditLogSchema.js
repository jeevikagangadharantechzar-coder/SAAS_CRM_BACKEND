import mongoose from "mongoose";

const auditLogSchema = new mongoose.Schema(
  {
    action:      { type: String, required: true },
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    details:     { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

export default auditLogSchema;
