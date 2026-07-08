import mongoose from "mongoose";
import { masterConn } from "../../config/masterDB.js";

// Mirrors the tenant role permission keys (models/schemas/roleSchema.js) so a
// tenant's effective access is the intersection of their role permissions and
// their plan's enabled features. Defaults to true so existing plans that were
// created before this field existed keep behaving as "all features enabled".
const planFeaturesSchema = new mongoose.Schema(
  {
    dashboard:           { type: Boolean, default: true },
    leads:               { type: Boolean, default: true },
    create_lead:         { type: Boolean, default: true },
    deals_all:           { type: Boolean, default: true },
    create_deal:         { type: Boolean, default: true },
    deals_pipeline:      { type: Boolean, default: true },
    invoices:            { type: Boolean, default: true },
    proposal:            { type: Boolean, default: true },
    activities:          { type: Boolean, default: true },
    activities_calendar: { type: Boolean, default: true },
    activities_list:     { type: Boolean, default: true },
    users_roles:         { type: Boolean, default: true },
    admin_access:        { type: Boolean, default: true },
    email_chat:          { type: Boolean, default: true },
    email_campaigns:     { type: Boolean, default: true },
    whatsapp_chat:       { type: Boolean, default: true },
    reports:             { type: Boolean, default: true },
    analytics:           { type: Boolean, default: true },
    settings:            { type: Boolean, default: true },
    streak_leaderboard:  { type: Boolean, default: true },
    assigned_tasks:      { type: Boolean, default: true },
    task_management:     { type: Boolean, default: true },
    target_management:   { type: Boolean, default: true },
    meetings:            { type: Boolean, default: true },
    google_meet_sync:    { type: Boolean, default: true },
    zoom_meetings:       { type: Boolean, default: true },
    messages:            { type: Boolean, default: true },
    chatbot:             { type: Boolean, default: true },
    integration_facebook:  { type: Boolean, default: true },
    integration_linkedin:  { type: Boolean, default: true },
    integration_justdial:  { type: Boolean, default: true },
    integration_indiamart: { type: Boolean, default: true },
    integration_99acres:   { type: Boolean, default: true },
    integration_sulekha:   { type: Boolean, default: true },
  },
  { _id: false }
);

const planTierSchema = new mongoose.Schema(
  {
    billing_cycle:   { type: String, enum: ["monthly", "half_yearly", "yearly"], required: true },
    price:           { type: Number, default: 0, min: 0 },
    duration_months: { type: Number, default: 1, min: 1 },
    grace_days:      { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

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
    billing_cycle:        { type: String, enum: ["monthly", "half_yearly", "yearly", "one_time"], default: "monthly" },
    tiers:                { type: [planTierSchema], default: [] },

   // max_tenants:          { type: Number, default: 0 },
    max_users_per_tenant: { type: Number, default: 0 },

    features:             { type: planFeaturesSchema, default: () => ({}) },

    is_recommended:       { type: Boolean, default: false },
    is_visible:           { type: Boolean, default: true },
    sort_order:           { type: Number, default: 0 },
    trial_days:           { type: Number, default: 0 },

    is_deleted:           { type: Boolean, default: false },
  },
  { timestamps: true }
);

subscriptionPlanSchema.index(
  { plan_code: 1 },
  { unique: true, partialFilterExpression: { is_deleted: false } }
);
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
