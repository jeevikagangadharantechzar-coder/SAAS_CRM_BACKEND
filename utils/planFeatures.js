import Tenant from "../models/master/Tenant.js";

/**
 * Loads the enabled/disabled feature map for the tenant behind this request.
 * Returns null when there's no tenant context or no plan assigned — callers
 * should treat that as "allow" (legacy/no-plan tenants keep full access).
 */
export const getTenantPlanFeatures = async (req) => {
  const tenantId = req.tenantId || req.tenant?._id || req.user?.tenantId;
  if (!tenantId) return null;

  const tenant = await Tenant.findById(tenantId).populate("plan_id");
  if (!tenant || !tenant.plan_id) return null;

  return tenant.plan_id.features || null;
};

/**
 * A feature is only blocked when explicitly set to `false`. Missing/undefined
 * (legacy plans saved before this key existed, or no plan at all) defaults to
 * enabled so nothing breaks retroactively.
 *
 * `featureKey` may be a single key or an array of keys — an array is treated
 * as "enabled if ANY of these are enabled" (e.g. deals_all/deals_pipeline both
 * read from the same API, so either one being on should allow the request).
 */
export const isFeatureEnabled = (features, featureKey) => {
  const keys = Array.isArray(featureKey) ? featureKey : [featureKey];
  return keys.some((key) => features?.[key] !== false);
};
