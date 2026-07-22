import mongoose from "mongoose";

// Dedicated per-tenant activity log — lives inside each tenant's own
// database (registered in models/tenant/index.js), separate from AuditLog
// (which stays scoped to IndiaMart integration events only).
const activityLogSchema = new mongoose.Schema(
  {
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    userName:    { type: String, default: "", trim: true },
    userRole:    { type: String, default: "", trim: true },

    module: { type: String, required: true, index: true },
    action: { type: String, required: true },

    status:       { type: String, enum: ["Success", "Failed"], default: "Success", index: true },
    errorMessage: { type: String, default: "" },

    ip:        { type: String, default: "" },
    userAgent: { type: String, default: "" },

    method:         { type: String, default: "" },
    endpoint:       { type: String, default: "" },
    statusCode:     { type: Number, default: null },
    responseTimeMs: { type: Number, default: null },
    requestPayload: { type: mongoose.Schema.Types.Mixed, default: null },

    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

activityLogSchema.index({ createdAt: -1 });

export default activityLogSchema;
