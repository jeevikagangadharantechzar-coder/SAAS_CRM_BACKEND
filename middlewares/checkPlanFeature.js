import { getTenantPlanFeatures, isFeatureEnabled } from "../utils/planFeatures.js";

/**
 * Blocks access to a route (or an entire router, via router.use) unless the
 * tenant's current subscription plan has the given feature enabled.
 *
 * Usage:
 *   router.use(checkPlanFeature("leads"))
 *   router.use(checkPlanFeature(["deals_all", "deals_pipeline"])) // enabled if ANY match
 *
 * featureKey must match one of the boolean keys on the SubscriptionPlan
 * `features` sub-schema (models/master/SubscriptionPlan.model.js). Adding a
 * new gated feature only requires a new key there plus this one line on the
 * relevant router — no other code needs to change.
 */
const checkPlanFeature = (featureKey) => async (req, res, next) => {
  try {
    const features = await getTenantPlanFeatures(req);

    // No tenant context, no tenant record, or no plan assigned — allow by default
    if (features === null) return next();

    if (!isFeatureEnabled(features, featureKey)) {
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
