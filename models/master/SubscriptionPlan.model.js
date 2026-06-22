import mongoose from "mongoose";
import { masterConn } from "../../config/masterDB.js";

const subscriptionPlanSchema = new mongoose.Schema(
  {
    plan_name:            { type: String, required: true, trim: true },
    plan_code:            { type: String, required: true, unique: true, lowercase: true, trim: true },
    plan_type:            { type: String, enum: ["free", "paid", "enterprise"], required: true },
    status:               { type: String, enum: ["active", "inactive", "archived"], default: "active" },
    description:          { type: String, default: "" },

    price_monthly:        { type: Number, default: 0, min: 0 },
    price_yearly:         { type: Number, default: 0, min: 0 },
    currency:             { type: String, default: "USD", maxlength: 3 },
    billing_cycle:        { type: String, enum: ["monthly", "yearly", "one_time"], required: true },

   // max_tenants:          { type: Number, default: 0 },
    max_users_per_tenant: { type: Number, default: 0 },

    is_recommended:       { type: Boolean, default: false },
    is_visible:           { type: Boolean, default: true },
    sort_order:           { type: Number, default: 0 },
    trial_days:           { type: Number, default: 0 },

    is_deleted:           { type: Boolean, default: false },
  },
  { timestamps: true }
);

subscriptionPlanSchema.index({ plan_code: 1 }, { unique: true });
subscriptionPlanSchema.index({ status: 1, is_visible: 1 });

subscriptionPlanSchema.statics.getActivePlans = function () {
  return this.find({ status: "active", is_deleted: false });
};

subscriptionPlanSchema.statics.getPublicPlans = function () {
  return this.find({ status: "active", is_visible: true, is_deleted: false })
    .select("-is_deleted -__v")
    .sort("sort_order");
};

const SubscriptionPlan = masterConn.model("SubscriptionPlan", subscriptionPlanSchema);
export default SubscriptionPlan;
