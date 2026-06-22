import Tenant from "../models/master/Tenant.js";
import { getTenantModels } from "../models/tenant/index.js";

/**
 * Checks whether the tenant has reached a plan limit before allowing an action.
 *
 * Usage:
 *   router.post("/users", checkPlanLimit("max_users_per_tenant"), createUser)
 *   router.post("/tenants", checkPlanLimit("max_tenants"), createTenant)
 *
 * Supported limitKey values:
 *   "max_users_per_tenant" — counts active users in the tenant's own DB
 *   "max_tenants"          — counts tenants on this plan in the master DB
 */
const checkPlanLimit = (limitKey) => async (req, res, next) => {
  try {
    const tenantId = req.tenantId || req.tenant?._id || req.user?.tenantId;

    // No tenant context in this request — skip the check
    if (!tenantId) return next();

    const tenant = await Tenant.findById(tenantId).populate("plan_id");

    // No tenant record or no plan assigned — allow by default
    if (!tenant || !tenant.plan_id) return next();

    const plan = tenant.plan_id;
    const planLimit = plan[limitKey];

    // 0 means unlimited
    if (planLimit === 0) return next();

    let currentCount = 0;

    if (limitKey === "max_users_per_tenant") {
      if (!req.tenantDB) return next();
      const { User } = getTenantModels(req.tenantDB);
      currentCount = await User.countDocuments();
    } else if (limitKey === "max_tenants") {
      currentCount = await Tenant.countDocuments({
        plan_id: plan._id,
        plan_status: "active",
      });
    }

    if (currentCount >= planLimit) {
      const errorMessage =
        limitKey === "max_users_per_tenant"
          ? "User limit reached for your current plan. Please upgrade."
          : "Tenant limit reached for your current plan. Please upgrade.";

      return res.status(403).json({
        success: false,
        error: errorMessage,
        code: "PLAN_LIMIT_EXCEEDED",
      });
    }

    next();
  } catch (err) {
    console.error("checkPlanLimit error:", err);
    next(err);
  }
};

export default checkPlanLimit;
