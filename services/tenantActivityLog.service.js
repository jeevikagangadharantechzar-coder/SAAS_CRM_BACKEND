import { getTenantModels } from "../models/tenant/index.js";

/**
 * Single write path for the Tenant Activity Logger. Every hook point (the
 * request middleware, tenant.controller.js, cron jobs) calls this — never
 * write to the ActivityLog model directly elsewhere.
 *
 * Logs live inside the tenant's OWN database (registered in
 * models/tenant/index.js), so a tenantDB connection is required — there is
 * no cross-tenant store.
 *
 * Fire-and-forget by design: a logging failure must never break or delay
 * the real request/job it's observing.
 */
export async function logActivity(
  tenantDB,
  {
    performedBy = null,
    userName = "",
    userRole = "",
    module,
    action,
    status = "Success",
    errorMessage = "",
    ip = "",
    userAgent = "",
    method = "",
    endpoint = "",
    statusCode = null,
    responseTimeMs = null,
    requestPayload = null,
    metadata = {},
  }
) {
  if (!tenantDB) return;
  try {
    const { ActivityLog } = getTenantModels(tenantDB);
    await ActivityLog.create({
      performedBy: performedBy || null,
      userName: userName || "",
      userRole: userRole || "",
      module,
      action,
      status,
      errorMessage,
      ip,
      userAgent,
      method,
      endpoint,
      statusCode,
      responseTimeMs,
      requestPayload,
      metadata,
    });
  } catch (err) {
    console.error("[ActivityLog] Failed to write log entry:", err.message);
  }
}

export default { logActivity };
