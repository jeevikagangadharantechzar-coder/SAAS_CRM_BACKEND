import mongoose from "mongoose";
import { masterConn } from "../../config/masterDB.js";

const linkedinWebhookLogSchema = new mongoose.Schema(
  {
    payload:     { type: mongoose.Schema.Types.Mixed },
    leadFormUrn: { type: String, index: true },
    status:      { type: String, enum: ["success", "failed", "ignored"], default: "success" },
    error:       { type: String, default: null },
    processedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const LinkedInWebhookLog = masterConn.model("LinkedInWebhookLog", linkedinWebhookLogSchema);
export default LinkedInWebhookLog;
