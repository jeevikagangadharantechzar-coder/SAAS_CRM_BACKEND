import Tenant from "../models/master/Tenant.js";
import { getTenantDB } from "../config/tenantDB.js";

/**
 * Reads :tenantSlug from the URL, looks it up in the master DB,
 * and attaches req.tenant + req.tenantDB before continuing.
 *
 * Skip entirely for the /superadmin prefix (handled by superAdminAuth).
 */
export async function resolveTenant(req, res, next) {
  const slug = req.params.tenantSlug;

  // Should not reach here for superadmin, but guard defensively
  if (slug === "superadmin") return next();

  try {
    const tenant = await Tenant.findOne({ slug, isActive: true });

    if (!tenant) {
      return res.status(404).json({ error: "Tenant not found" });
    }

    req.tenant    = tenant;
    req.tenantDB  = await getTenantDB(tenant.dbName);

    next();
  } catch (err) {
    console.error("resolveTenant error:", err.message);
    res.status(500).json({ error: "Tenant resolution failed" });
  }
}
