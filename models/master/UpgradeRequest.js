import mongoose from "mongoose";
import { masterConn } from "../../config/masterDB.js";

const upgradeRequestSchema = new mongoose.Schema(
  {
    tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    plan_id: { type: mongoose.Schema.Types.ObjectId, ref: "SubscriptionPlan", required: true },
    wanted_users: { type: Number, required: true },
    login_days: { type: Number, required: true },
    description: { type: String, default: "" },
    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
    rejection_reason: { type: String, default: "" },
    type: { type: String, enum: ["limit_over", "mid_cycle"], required: true },
    prorated_discount: { type: Number, default: 0 },
    final_price: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const UpgradeRequest = masterConn.model("UpgradeRequest", upgradeRequestSchema);
export default UpgradeRequest;
