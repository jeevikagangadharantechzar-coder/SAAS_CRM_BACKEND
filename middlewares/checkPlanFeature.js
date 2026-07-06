import Tenant from "../models/master/Tenant.js";

/**
 * Blocks access to a route unless the tenant's current subscription plan has
 * the given feature enabled.
 *
 * Usage:
 *   router.get("/whatsapp/messages", checkPlanFeature("whatsapp_chat"), getMessages)
 *
 * featureKey must match one of the boolean keys on the SubscriptionPlan
 * `features` sub-schema (models/master/SubscriptionPlan.model.js).
 *
 * Not currently attached to any route — available for gating specific
 * endpoints as needed.
 */
const checkPlanFeature = (featureKey) => async (req, res, next) => {
  try {
    const tenantId = req.tenantId || req.tenant?._id || req.user?.tenantId;

    // No tenant context in this request — skip the check
    if (!tenantId) return next();

    const tenant = await Tenant.findById(tenantId).populate("plan_id");

    // No tenant record or no plan assigned — allow by default
    if (!tenant || !tenant.plan_id) return next();

    const isEnabled = tenant.plan_id.features?.[featureKey];

    // undefined (legacy plans without this key saved) defaults to allowed
    if (isEnabled === false) {
      return res.status(403).json({
        success: false,
        error: "This feature is not included in your current subscription plan.",
        code: "FEATURE_NOT_INCLUDED",
      });
    }

    next();
  } catch (err) {
    console.error("checkPlanFeature error:", err);
    next(err);
  }
};

export default checkPlanFeature;
