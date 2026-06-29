import mongoose from "mongoose";
import SubscriptionPlan from "../models/master/SubscriptionPlan.model.js";
import Tenant from "../models/master/Tenant.js";

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
  const existing = await SubscriptionPlan.findOne({ plan_code: code });
  if (existing) throw appError("Plan code already exists", 400);

  const plan = await SubscriptionPlan.create({ ...data, plan_code: code });
  return plan;
};

export const updatePlan = async (id, data) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw appError("Invalid plan ID", 400);
  }

  const existing = await SubscriptionPlan.findOne({ _id: id, is_deleted: false });
  if (!existing) throw appError("Subscription plan not found", 404);

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

  const plan = await SubscriptionPlan.findByIdAndUpdate(id, data, {
    new: true,
    runValidators: true,
  });

  return plan;
};

export const deletePlan = async (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw appError("Invalid plan ID", 400);
  }

  const existing = await SubscriptionPlan.findOne({ _id: id, is_deleted: false });
  if (!existing) throw appError("Subscription plan not found", 404);

  const activeTenants = await Tenant.countDocuments({ plan_id: id, plan_status: "active" });
  if (activeTenants > 0) {
    throw appError(
      `Cannot delete plan. ${activeTenants} tenants are actively using it.`,
      400
    );
  }

  existing.is_deleted = true;
  await existing.save();

  return { message: "Plan soft-deleted successfully" };
};

export const getPublicPlans = async () => {
  return SubscriptionPlan.getPublicPlans();
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
      .populate("plan_id", "plan_name plan_code plan_type price_monthly price_yearly currency billing_cycle status")
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

  if (plan.trial_days && plan.trial_days > 0) {
    plan_end_date = new Date();
    plan_end_date.setDate(plan_end_date.getDate() + plan.trial_days);
  } else if (billing_cycle === "monthly") {
    plan_end_date = new Date();
    plan_end_date.setDate(plan_end_date.getDate() + 30);
  } else if (billing_cycle === "yearly") {
    plan_end_date = new Date();
    plan_end_date.setDate(plan_end_date.getDate() + 365);
  }

  tenant.plan_id = planId;
  tenant.plan_status = "active";
  tenant.plan_start_date = plan_start_date;
  tenant.plan_end_date = plan_end_date;
  await tenant.save();

  return tenant;
};
