const VALID_PLAN_TYPES   = ["free", "paid", "enterprise"];
const VALID_STATUSES     = ["active", "inactive", "archived"];
const VALID_CYCLES       = ["monthly", "yearly", "one_time"];
const PLAN_CODE_REGEX    = /^[a-z0-9_]+$/;

const fail = (res, message) =>
  res.status(400).json({ success: false, error: message, code: "VALIDATION_ERROR" });

export const validateCreatePlan = (req, res, next) => {
  const {
    plan_name, plan_code, plan_type, status,
    price_monthly, price_yearly, currency,
    billing_cycle, max_tenants, max_users_per_tenant,
  } = req.body;

  if (!plan_name || typeof plan_name !== "string" ||
      plan_name.trim().length < 2 || plan_name.trim().length > 100) {
    return fail(res, "plan_name is required and must be between 2 and 100 characters");
  }

  if (!plan_code || typeof plan_code !== "string") {
    return fail(res, "plan_code is required");
  }
  const normalizedCode = plan_code.toLowerCase().trim();
  if (normalizedCode.length > 50 || !PLAN_CODE_REGEX.test(normalizedCode)) {
    return fail(res, "plan_code must be lowercase alphanumeric/underscores only, max 50 chars");
  }

  if (!plan_type || !VALID_PLAN_TYPES.includes(plan_type)) {
    return fail(res, `plan_type is required and must be one of: ${VALID_PLAN_TYPES.join(", ")}`);
  }

  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    return fail(res, `status must be one of: ${VALID_STATUSES.join(", ")}`);
  }

  if (plan_type !== "free") {
    if (price_monthly === undefined || price_monthly === null ||
        isNaN(Number(price_monthly)) || Number(price_monthly) < 0) {
      return fail(res, "price_monthly is required and must be a non-negative number for non-free plans");
    }
  }

  if (price_yearly !== undefined &&
      (isNaN(Number(price_yearly)) || Number(price_yearly) < 0)) {
    return fail(res, "price_yearly must be a non-negative number");
  }

  if (currency !== undefined &&
      (typeof currency !== "string" || currency.trim().length !== 3)) {
    return fail(res, "currency must be a 3-character string (e.g. USD)");
  }

  if (!billing_cycle || !VALID_CYCLES.includes(billing_cycle)) {
    return fail(res, `billing_cycle is required and must be one of: ${VALID_CYCLES.join(", ")}`);
  }

  if (max_tenants !== undefined &&
      (!Number.isInteger(Number(max_tenants)) || Number(max_tenants) < 0)) {
    return fail(res, "max_tenants must be a non-negative integer");
  }

  if (max_users_per_tenant !== undefined &&
      (!Number.isInteger(Number(max_users_per_tenant)) || Number(max_users_per_tenant) < 0)) {
    return fail(res, "max_users_per_tenant must be a non-negative integer");
  }

  next();
};

export const validateUpdatePlan = (req, res, next) => {
  const {
    plan_name, plan_code, plan_type, status,
    price_monthly, price_yearly, currency,
    billing_cycle, max_tenants, max_users_per_tenant,
  } = req.body;

  if (plan_name !== undefined &&
      (typeof plan_name !== "string" ||
       plan_name.trim().length < 2 || plan_name.trim().length > 100)) {
    return fail(res, "plan_name must be between 2 and 100 characters");
  }

  if (plan_code !== undefined) {
    const normalizedCode = plan_code.toLowerCase().trim();
    if (normalizedCode.length > 50 || !PLAN_CODE_REGEX.test(normalizedCode)) {
      return fail(res, "plan_code must be lowercase alphanumeric/underscores only, max 50 chars");
    }
  }

  if (plan_type !== undefined && !VALID_PLAN_TYPES.includes(plan_type)) {
    return fail(res, `plan_type must be one of: ${VALID_PLAN_TYPES.join(", ")}`);
  }

  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    return fail(res, `status must be one of: ${VALID_STATUSES.join(", ")}`);
  }

  if (price_monthly !== undefined &&
      (isNaN(Number(price_monthly)) || Number(price_monthly) < 0)) {
    return fail(res, "price_monthly must be a non-negative number");
  }

  if (price_yearly !== undefined &&
      (isNaN(Number(price_yearly)) || Number(price_yearly) < 0)) {
    return fail(res, "price_yearly must be a non-negative number");
  }

  if (currency !== undefined &&
      (typeof currency !== "string" || currency.trim().length !== 3)) {
    return fail(res, "currency must be a 3-character string (e.g. USD)");
  }

  if (billing_cycle !== undefined && !VALID_CYCLES.includes(billing_cycle)) {
    return fail(res, `billing_cycle must be one of: ${VALID_CYCLES.join(", ")}`);
  }

  if (max_tenants !== undefined &&
      (!Number.isInteger(Number(max_tenants)) || Number(max_tenants) < 0)) {
    return fail(res, "max_tenants must be a non-negative integer");
  }

  if (max_users_per_tenant !== undefined &&
      (!Number.isInteger(Number(max_users_per_tenant)) || Number(max_users_per_tenant) < 0)) {
    return fail(res, "max_users_per_tenant must be a non-negative integer");
  }

  next();
};
