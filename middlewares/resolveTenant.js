import Tenant from "../models/master/Tenant.js";
import { getTenantDB } from "../config/tenantDB.js";
import { masterConn } from "../config/masterDB.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  // The master DB connection can drop mid-session (Atlas idle disconnects,
  // laptop sleep/wake, wifi/VPN changes) without the driver reconnecting in
  // time for this request. Retrying once after a short pause covers that
  // transient window instead of failing every tenant-scoped route until the
  // process is restarted.
  const attempt = () => Tenant.findOne({ slug, isActive: true });

  let tenant;
  try {
    tenant = await attempt();
  } catch (err) {
    console.error(
      `resolveTenant error (readyState=${masterConn.readyState}):`,
      err.message
    );
    try {
      await sleep(500);
      tenant = await attempt();
    } catch (retryErr) {
      console.error(
        `resolveTenant retry failed (readyState=${masterConn.readyState}):`,
        retryErr.message
      );
      return res.status(503).json({ error: "Tenant resolution temporarily unavailable, please retry" });
    }
  }

  try {
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
