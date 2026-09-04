import mongoose from "mongoose";
import SubscriptionPlan from "../models/master/SubscriptionPlan.model.js";
import Tenant from "../models/master/Tenant.js";
import UpgradeRequest from "../models/master/UpgradeRequest.js";

const appError = (message, statusCode) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

export const getAllPlans = async ({ status, plan_type, page = 1, limit = 10 }) => {
  const filter = { is_deleted: false };
  if (status) filter.status = status.toLowerCase();
  if (plan_type) filter.plan_type = plan_type.toLowerCase();

  const skip = (Number(page) - 1) * Number(limit);

  const [plans, total] = await Promise.all([
    SubscriptionPlan.find(filter)
      .skip(skip)
      .limit(Number(limit))
      .sort({ sort_order: 1, createdAt: -1 }),
    SubscriptionPlan.countDocuments(filter),
  ]);

  return { plans, total };
};

export const getPlanById = async (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw appError("Invalid plan ID", 400);
  }

  const plan = await SubscriptionPlan.findOne({ _id: id, is_deleted: false });
  if (!plan) throw appError("Subscription plan not found", 404);

  return plan;
};

export const createPlan = async (data) => {
  const code = data.plan_code?.toLowerCase().trim();
  const existing = await SubscriptionPlan.findOne({ plan_code: code, is_deleted: false });
  if (existing) throw appError("Plan code already exists", 400);

  if (data.price_monthly !== undefined && data.price_monthly < 0)
    throw appError("Monthly price cannot be negative", 400);
  if (data.price_yearly !== undefined && data.price_yearly < 0)
    throw appError("Yearly price cannot be negative", 400);

  const plan = await SubscriptionPlan.create({ ...data, plan_code: code });
  return plan;
};

export const updatePlan = async (id, data) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw appError("Invalid plan ID", 400);
  }
  //check if status is changing to inactive then check if any tenant is using this plan then show error
  const existing = await SubscriptionPlan.findOne({ _id: id, is_deleted: false });
  if (!existing) throw appError("Subscription plan not found", 404);
    if (data.status === "inactive" && existing.status !== "inactive") {
    const activeTenants = await Tenant.countDocuments({ plan_id: id, plan_status: "active" });
    if (activeTenants > 0) {
      throw appError(
        `${activeTenants} user(s) are currently using this plan, you cannot mark it as inactive.`,
        400
      );
    }
  }
  if (data.plan_code && data.plan_code.toLowerCase().trim() !== existing.plan_code) {
    const tenantCount = await Tenant.countDocuments({ plan_id: id, plan_status: "active" });
    if (tenantCount > 0) {
      throw appError(
        `Cannot change plan_code. ${tenantCount} tenant(s) are actively using this plan.`,
        400
      );
    }
    data.plan_code = data.plan_code.toLowerCase().trim();
  }

  if (data.price_monthly !== undefined && data.price_monthly < 0)
    throw appError("Monthly price cannot be negative", 400);
  if (data.price_yearly !== undefined && data.price_yearly < 0)
    throw appError("Yearly price cannot be negative", 400);

  const plan = await SubscriptionPlan.findByIdAndUpdate(id, data, {
    new: true,
    runValidators: true,
  });

  // Notify all active tenants using this plan about the update
  let changes = [];
  if (data.max_users_per_tenant !== undefined && data.max_users_per_tenant > existing.max_users_per_tenant) {
    changes.push(`User limit increased to ${data.max_users_per_tenant}`);
  }
  if (data.features) {
    const newFeatures = Object.keys(data.features).filter(
      (k) => data.features[k] === true && existing.features?.[k] !== true
    );
    if (newFeatures.length > 0) {
      changes.push(`New features added: ${newFeatures.map(f => f.replace(/_/g, ' ')).join(', ')}`);
    }
  }

  let planUpdateMessage = "";
  if (changes.length > 0) {
    planUpdateMessage = `Great news! Your subscription plan (${plan.plan_name}) has been upgraded:\n\n• ${changes.join('\n• ')}`;
  } else {
    planUpdateMessage = `Your subscription plan (${plan.plan_name}) has been updated by the Super Admin. Enjoy the new capabilities!`;
  }

  await Tenant.updateMany(
    { plan_id: id, plan_status: "active" },
    { $set: { plan_update_message: planUpdateMessage } }
  );

  return plan;
};

export const deletePlan = async (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw appError("Invalid plan ID", 400);
  }

  const existing = await SubscriptionPlan.findById(id);
  if (!existing) throw appError("Subscription plan not found", 404);

  const activeTenants = await Tenant.countDocuments({ plan_id: id, plan_status: "active" });
  if (activeTenants > 0) {
    throw appError(
      `Cannot delete plan. ${activeTenants} tenant${activeTenants === 1 ? " is" : "s are"} actively using it.`,
      400
    );
  }

  // Delete all pending upgrade requests for this plan
  await UpgradeRequest.deleteMany({ plan_id: id, status: "pending" });

  await SubscriptionPlan.findByIdAndDelete(id);

  return { message: "Plan and related pending upgrade requests deleted successfully" };
};

export const getPublicPlans = async () => {
  return SubscriptionPlan.getPublicPlans();
};

export const getLandingPagePlans = async () => {
  return SubscriptionPlan.getLandingPagePlans();
};

export const getTenantSubscriptions = async ({ plan_status, plan_id, page = 1, limit = 10 }) => {
  const filter = {};
  if (plan_status) filter.plan_status = plan_status;
  if (plan_id) {
    if (!mongoose.Types.ObjectId.isValid(plan_id)) throw appError("Invalid plan ID", 400);
    filter.plan_id = plan_id;
  }

  const skip = (Number(page) - 1) * Number(limit);

  const [tenants, total] = await Promise.all([
    Tenant.find(filter)
      .populate("plan_id", "plan_name plan_code plan_type price_monthly price_yearly currency billing_cycle status features")
      .select("name slug adminEmail adminName isActive plan_id plan_status plan_start_date plan_end_date createdAt")
      .skip(skip)
      .limit(Number(limit))
      .sort({ createdAt: -1 }),
    Tenant.countDocuments(filter),
  ]);

  return { tenants, total };
};

export const assignPlanToTenant = async (tenantId, planId, billing_cycle) => {
  if (!mongoose.Types.ObjectId.isValid(tenantId)) {
    throw appError("Invalid tenant ID", 400);
  }
  if (!mongoose.Types.ObjectId.isValid(planId)) {
    throw appError("Invalid plan ID", 400);
  }

  const plan = await SubscriptionPlan.findOne({
    _id: planId,
    status: "active",
    is_deleted: false,
  });
  if (!plan) throw appError("Subscription plan not found or not active", 404);

  const tenant = await Tenant.findById(tenantId);
  if (!tenant) throw appError("Tenant not found", 404);

  const plan_start_date = new Date();
  let plan_end_date = null;

  if (billing_cycle === "monthly") {
    plan_end_date = new Date(plan_start_date);
    plan_end_date.setMonth(plan_end_date.getMonth() + 1);
  } else if (billing_cycle === "half_yearly") {
    plan_end_date = new Date(plan_start_date);
    plan_end_date.setMonth(plan_end_date.getMonth() + 6);
  } else if (billing_cycle === "yearly") {
    plan_end_date = new Date(plan_start_date);
    plan_end_date.setFullYear(plan_end_date.getFullYear() + 1);
  } else if (plan.trial_days && plan.trial_days > 0) {
    plan_end_date = new Date(plan_start_date);
    plan_end_date.setDate(plan_end_date.getDate() + plan.trial_days);
  }

  tenant.plan_id = planId;
  tenant.plan_status = "active";
  tenant.plan_billing_cycle = billing_cycle;
  tenant.plan_start_date = plan_start_date;
  tenant.plan_end_date = plan_end_date;
  await tenant.save();

  return tenant;
};
