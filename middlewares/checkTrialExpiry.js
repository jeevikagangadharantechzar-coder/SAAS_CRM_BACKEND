// Hardens the free-trial/subscription expiry block so it also applies to an
// already-logged-in session (JWT lives up to 1 day), not just the login call
// itself (controllers/user.controller.js already blocks fresh logins).
// Runs after resolveTenant, which attaches req.tenant.
//
// A short allowlist stays reachable even while blocked so the user can still
// see who they are and log out.
import { formatExpiryDate } from "../utils/trialDate.util.js";

const ALLOWLIST_SUFFIXES = ["/users/login", "/users/logout", "/users/me", "/trial-status"];

export function checkTrialExpiry(req, res, next) {
  const tenant = req.tenant;
  if (!tenant) return next();

  const path = req.path || "";
  if (ALLOWLIST_SUFFIXES.some((suffix) => path.endsWith(suffix))) return next();

  const isExpired =
    tenant.plan_status === "expired" ||
    (tenant.plan_end_date && new Date() > new Date(tenant.plan_end_date));

  if (!isExpired) return next();

  const isTrial = tenant.plan_status === "trial";
  const expiryDate = tenant.plan_end_date ? formatExpiryDate(tenant.plan_end_date) : null;
  return res.status(403).json({
    success: false,
    planExpired: true,
    trialExpired: isTrial,
    expiryDate,
    message: isTrial
      ? "Your 14 days free trial has ended. Please upgrade your plan to continue using the CRM."
      : "Your subscription validity has expired. Please contact superadmin to renew.",
  });
}
