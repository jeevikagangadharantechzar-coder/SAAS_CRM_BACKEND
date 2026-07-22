import { logActivity } from "../services/tenantActivityLog.service.js";

// Friendly display names for known route segments. Anything not listed here
// falls back to a title-cased version of the raw segment, so new routes are
// still logged without needing an update here.
const MODULE_LABELS = {
  users: "Users",
  leads: "Leads",
  deals: "Deals",
  roles: "Roles",
  activity: "Activities",
  invoices: "Invoices",
  proposal: "Proposals",
  dashboard: "Dashboard",
  notifications: "Notifications",
  gmail: "Gmail",
  "google-auth": "Google Auth",
  "zoom-auth": "Zoom Auth",
  sales: "Sales Reports",
  ai: "AI Assistant",
  streak: "Streak",
  calllogs: "Call Logs",
  bot: "Bot",
  "client-ltv": "Client LTV",
  cltv: "Client LTV",
  "email-templates": "Email Templates",
  "lost-deals": "Lost Deals",
  settings: "Settings",
  email: "Email",
  files: "Files",
  meta: "Meta Integration",
  linkedin: "LinkedIn Integration",
  tasks: "Tasks",
  targets: "Targets",
  chat: "Chat",
  groups: "Groups",
  justdial: "JustDial Integration",
  indiamart: "IndiaMart Integration",
  "99acres": "99acres Integration",
  sulekha: "Sulekha Integration",
  meetings: "Meetings",
  "google-integration": "Google Integration",
  "zoom-integration": "Zoom Integration",
  location: "Location",
  "trial-status": "Trial Status",
  public: "Public",
};

const METHOD_VERBS = { GET: "Viewed", POST: "Created", PUT: "Updated", PATCH: "Updated", DELETE: "Deleted" };

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

// All tunables come from .env — read lazily (per-request) rather than at
// module load time, since this file may be imported before app.js runs
// dotenv.config(). Defaults keep the logger working even if unset.
function isLoggingEnabled() {
  return (process.env.ACTIVITY_LOG_ENABLED ?? "true") !== "false";
}

function shouldLogSuccessfulGet() {
  return (process.env.ACTIVITY_LOG_LOG_SUCCESSFUL_GET ?? "true") !== "false";
}

function payloadMaxChars() {
  return Number(process.env.ACTIVITY_LOG_PAYLOAD_MAX_CHARS) || 2000;
}

function redactFields() {
  return (process.env.ACTIVITY_LOG_REDACT_FIELDS || "password,token,secret,authorization,apikey,api_key")
    .split(",")
    .map((f) => f.trim().toLowerCase())
    .filter(Boolean);
}

// Deep-redacts sensitive keys (case-insensitive) out of a request payload
// before it's persisted — matters most for auth endpoints, which flow
// through this same pipeline (e.g. a failed login attempt).
function redact(value, redactKeys) {
  if (Array.isArray(value)) return value.map((v) => redact(v, redactKeys));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = redactKeys.includes(key.toLowerCase()) ? "[REDACTED]" : redact(val, redactKeys);
    }
    return out;
  }
  return value;
}

function buildRequestPayload(req) {
  const payload = {};
  if (req.params && Object.keys(req.params).length) payload.params = req.params;
  if (req.query && Object.keys(req.query).length) payload.query = req.query;
  if (req.body && Object.keys(req.body).length) payload.body = req.body;
  if (!Object.keys(payload).length) return null;

  const redacted = redact(payload, redactFields());
  const serialized = JSON.stringify(redacted);
  const limit = payloadMaxChars();
  if (serialized.length <= limit) return redacted;

  // Truncate oversized payloads (large file/base64 uploads, bulk imports)
  // rather than storing them in full — keeps log documents small.
  return { truncated: true, preview: serialized.slice(0, limit) };
}

function titleCase(segment = "") {
  return segment.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function isEntityId(segment) {
  return OBJECT_ID_RE.test(segment) || /^\d+$/.test(segment);
}

// Splits the request path into module + trailing segments, independent of
// Express router internals (safe to read after the request has finished).
// Tenant-scoped requests always look like /:tenantSlug/api/<module>/...
function parsePath(originalUrl) {
  const clean = originalUrl.split("?")[0];
  const segments = clean.split("/").filter(Boolean);

  const apiIndex = segments.indexOf("api");
  const rest = apiIndex >= 0 ? segments.slice(apiIndex + 1) : segments;

  const moduleSeg = rest[0] || "general";
  const tail = rest.slice(1);
  const lastStatic = [...tail].reverse().find((s) => !isEntityId(s));

  return { moduleSeg, tail, lastStatic };
}

function deriveModuleAndAction(req) {
  const { moduleSeg, tail, lastStatic } = parsePath(req.originalUrl);
  const verb = METHOD_VERBS[req.method] || req.method;

  if (tail.includes("login")) return { module: "Authentication", action: "Login" };
  if (tail.includes("logout")) return { module: "Authentication", action: "Logout" };

  const moduleLabel = MODULE_LABELS[moduleSeg] || titleCase(moduleSeg);

  if (lastStatic && lastStatic !== moduleSeg) {
    return { module: moduleLabel, action: `${titleCase(lastStatic)} (${verb})` };
  }
  return { module: moduleLabel, action: `${moduleLabel} ${verb}` };
}

// Skip successful reads only when ACTIVITY_LOG_LOG_SUCCESSFUL_GET=false.
// Failed reads (4xx/5xx) are always logged since those matter for auditing.
function shouldSkip(req, res) {
  return req.method === "GET" && res.statusCode < 400 && !shouldLogSuccessfulGet();
}

/**
 * Mount on the tenant router, AFTER resolveTenant — it needs req.tenantDB to
 * know which tenant database to write into. Observes the request outcome via
 * res.on("finish") — never alters the request/response, so it cannot break
 * existing behavior. Requests that never reach a resolved tenant (invalid
 * slug, inactive tenant) have no database to log into and are skipped.
 *
 * Doubles as the API request/response logger — every request/response pair
 * (method, endpoint, payload, status, response time) is captured on the same
 * document as the derived "activity" (module/action), per ACTIVITY_LOG_*
 * settings in .env.
 */
export function activityLogger() {
  return function (req, res, next) {
    if (!isLoggingEnabled() || !req.tenantDB) return next();

    const startedAt = Date.now();

    // Tap res.json so failure responses can surface their error message
    // without any controller having to call the logger explicitly.
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      res.locals.__loggedBody = body;
      return originalJson(body);
    };

    res.on("finish", () => {
      if (shouldSkip(req, res)) return;

      const body = res.locals.__loggedBody || {};
      const isFailure = res.statusCode >= 400;
      const { module, action } = deriveModuleAndAction(req);
      const userDoc = req.user;

      logActivity(req.tenantDB, {
        performedBy: userDoc?._id || null,
        userName: userDoc
          ? `${userDoc.firstName || ""} ${userDoc.lastName || ""}`.trim() || userDoc.email
          : req.body?.email || "",
        userRole: userDoc?.role?.name || "",
        module,
        action,
        status: isFailure ? "Failed" : "Success",
        errorMessage: isFailure ? body?.error || body?.message || "" : "",
        ip: req.ip || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "",
        userAgent: req.headers["user-agent"] || "",
        method: req.method,
        endpoint: req.originalUrl,
        statusCode: res.statusCode,
        responseTimeMs: Date.now() - startedAt,
        requestPayload: buildRequestPayload(req),
      }).catch((err) => console.error("[activityLogger] error:", err.message));
    });

    next();
  };
}

export default activityLogger;
