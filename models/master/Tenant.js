import mongoose from "mongoose";
import { masterConn } from "../../config/masterDB.js";

const tenantSchema = new mongoose.Schema(
  {
    name:       { type: String, required: true, trim: true },
    slug:       { type: String, required: true, unique: true, lowercase: true, trim: true },
    dbName:     { type: String, required: true, unique: true, trim: true },
    adminEmail: { type: String, required: true, unique: true, lowercase: true, trim: true },
    adminName:  { type: String, required: true, trim: true },
    phonenumber:{ type:String, trim:true },
    address:    { type:String, trim:true},
    source:     { type:String, trim:true, default: "" },
    currency:        { type: String, default: "USD", trim: true },
    isActive:        { type: Boolean, default: true },
    createdBy:       { type: mongoose.Schema.Types.ObjectId, default: null },

    plan_id:            { type: mongoose.Schema.Types.ObjectId, ref: "SubscriptionPlan", default: null },
    plan_status:        { type: String, enum: ["active", "grace", "expired", "cancelled", "trial"], default: "trial" },
    plan_billing_cycle: { type: String, default: "" },
    plan_start_date:    { type: Date, default: null },
    plan_end_date:      { type: Date, default: null },
    isDbRefreshed:   { type: Boolean, default: false },

    // Permanent snapshot of the plan the tenant actually started on, set once
    // at tenant creation and never touched again — plan_id/plan_billing_cycle
    // above get overwritten on every upgrade approval, so without this the
    // tenant's true starting point is lost after the first upgrade.
    initial_plan_id:       { type: mongoose.Schema.Types.ObjectId, ref: "SubscriptionPlan", default: null },
    initial_plan_name:     { type: String, default: "" },
    initial_billing_cycle: { type: String, default: "" },
    initial_price:         { type: Number, default: 0 },
    initial_max_users:     { type: Number, default: 0 },

    // Tracks which free-trial expiry reminders have already been sent so the
    // cron (cron/freeTrialCron.js) never notifies the same milestone twice.
    trialReminders: {
      sevenDaySent: { type: Boolean, default: false },
      threeDaySent: { type: Boolean, default: false },
      oneDaySent:   { type: Boolean, default: false },
    },
    expiredNotifSent: { type: Boolean, default: false },

    // Plan update announcement
    plan_update_message: { type: String, default: "" },
  },
  { timestamps: true }
);

const Tenant = masterConn.model("Tenant", tenantSchema);
export default Tenant;
