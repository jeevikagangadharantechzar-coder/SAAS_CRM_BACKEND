import * as planService from "../services/subscriptionPlan.service.js";

const sendError = (res, err) =>
  res.status(err.statusCode || 500).json({
    success: false,
    error: err.message,
    code: err.code || "SERVER_ERROR",
  });

export const getAllPlans = async (req, res) => {
  try {
    const { status, plan_type, page = 1, limit = 10 } = req.query;
    const { plans, total } = await planService.getAllPlans({
      status,
      plan_type,
      page: parseInt(page),
      limit: parseInt(limit),
    });

    return res.status(200).json({
      success: true,
      data: plans,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error("getAllPlans error:", err);
    return sendError(res, err);
  }
};

export const getPlanById = async (req, res) => {
  try {
    const plan = await planService.getPlanById(req.params.id);
    return res.status(200).json({
      success: true,
      data: plan,
      message: "Plan fetched successfully",
    });
  } catch (err) {
    console.error("getPlanById error:", err);
    return sendError(res, err);
  }
};

export const createPlan = async (req, res) => {
  try {
    const plan = await planService.createPlan(req.body);
    return res.status(201).json({
      success: true,
      data: plan,
      message: "Plan created successfully",
    });
  } catch (err) {
    console.error("createPlan error:", err);
    return sendError(res, err);
  }
};

export const updatePlan = async (req, res) => {
  try {
    const plan = await planService.updatePlan(req.params.id, req.body);
    return res.status(200).json({
      success: true,
      data: plan,
      message: "Plan updated successfully",
    });
  } catch (err) {
    console.error("updatePlan error:", err);
    return sendError(res, err);
  }
};

export const deletePlan = async (req, res) => {
  try {
    const result = await planService.deletePlan(req.params.id);
    return res.status(200).json({
      success: true,
      data: result,
      message: "Plan deleted successfully",
    });
  } catch (err) {
    console.error("deletePlan error:", err);
    return sendError(res, err);
  }
};

export const getPublicPlans = async (req, res) => {
  try {
    const plans = await planService.getPublicPlans();
    return res.status(200).json({
      success: true,
      data: plans,
      message: "Public plans fetched successfully",
    });
  } catch (err) {
    console.error("getPublicPlans error:", err);
    return sendError(res, err);
  }
};

export const getTenantSubscriptions = async (req, res) => {
  try {
    const { plan_status, plan_id, page = 1, limit = 10 } = req.query;
    const { tenants, total } = await planService.getTenantSubscriptions({
      plan_status,
      plan_id,
      page: parseInt(page),
      limit: parseInt(limit),
    });

    return res.status(200).json({
      success: true,
      data: tenants,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error("getTenantSubscriptions error:", err);
    return sendError(res, err);
  }
};

export const assignPlanToTenant = async (req, res) => {
  try {
    const { tenantId, planId, billing_cycle } = req.body;

    if (!tenantId || !planId || !billing_cycle) {
      return res.status(400).json({
        success: false,
        error: "tenantId, planId, and billing_cycle are required",
        code: "VALIDATION_ERROR",
      });
    }

    const validCycles = ["monthly", "yearly", "one_time"];
    if (!validCycles.includes(billing_cycle)) {
      return res.status(400).json({
        success: false,
        error: `billing_cycle must be one of: ${validCycles.join(", ")}`,
        code: "VALIDATION_ERROR",
      });
    }

    const tenant = await planService.assignPlanToTenant(tenantId, planId, billing_cycle);
    return res.status(200).json({
      success: true,
      data: tenant,
      message: "Plan assigned to tenant successfully",
    });
  } catch (err) {
    console.error("assignPlanToTenant error:", err);
    return sendError(res, err);
  }
};
