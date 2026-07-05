import mongoose from "mongoose";
import { masterConn } from "../../config/masterDB.js";

const tenantSchema = new mongoose.Schema(
  {
    name:       { type: String, required: true, trim: true },
    slug:       { type: String, required: true, unique: true, lowercase: true, trim: true },
    dbName:     { type: String, required: true, unique: true, trim: true },
    adminEmail: { type: String, required: true, unique: true, lowercase: true, trim: true },
    adminName:  { type: String, required: true, trim: true },
    currency:        { type: String, default: "USD", trim: true },
    isActive:        { type: Boolean, default: true },
    createdBy:       { type: mongoose.Schema.Types.ObjectId, default: null },

    plan_id:         { type: mongoose.Schema.Types.ObjectId, ref: "SubscriptionPlan", default: null },
    plan_status:     { type: String, enum: ["active", "expired", "cancelled", "trial"], default: "trial" },
    plan_start_date: { type: Date, default: null },
    plan_end_date:   { type: Date, default: null },
    isDbRefreshed:   { type: Boolean, default: false },
  },
  { timestamps: true }
);

const Tenant = masterConn.model("Tenant", tenantSchema);
export default Tenant;
