import crypto from "crypto";
import GmailToken from "../models/GmailToken.js";

const sessions = new Map();

const SESSION_COOKIE = "gms_sid"; // cookie name
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const HMAC_SECRET =
  process.env.SESSION_HMAC_SECRET || crypto.randomBytes(32).toString("hex");

// Warn loudly if no persistent secret is set
if (!process.env.SESSION_HMAC_SECRET) {
  console.warn(
    "  SESSION_HMAC_SECRET not set in .env — sessions will be invalidated on every restart. " +
      "Set a stable 64-char hex secret in production.",
  );
}

// ─── HMAC helpers ──────────────────────────────────────────────────────────────
function signSessionId(id) {
  return crypto.createHmac("sha256", HMAC_SECRET).update(id).digest("hex");
}

function makeSignedCookie(id) {
  return `${id}.${signSessionId(id)}`;
}

function parseSignedCookie(raw) {
  if (!raw || typeof raw !== "string") return null;
  const dot = raw.lastIndexOf(".");
  if (dot === -1) return null;
  const id = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = signSessionId(id);
  // Constant-time comparison to prevent timing attacks
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
    return null;
  return id;
}

// ─── Session CRUD ──────────────────────────────────────────────────────────────
function createSession(gmailEmail) {
  const id = crypto.randomBytes(32).toString("hex");
  const data = {
    gmailEmail: gmailEmail.toLowerCase().trim(),
    createdAt: Date.now(),
    lastSeen: Date.now(),
  };
  sessions.set(id, data);
  return id;
}

function getSession(id) {
  if (!id) return null;
  const s = sessions.get(id);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    sessions.delete(id);
    return null;
  }
  s.lastSeen = Date.now();
  return s;
}

function destroySession(id) {
  if (id) sessions.delete(id);
}

// Periodic cleanup of expired sessions (runs every hour)
setInterval(
  () => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
    }
  },
  60 * 60 * 1000,
);

// ─── Cookie parser (we avoid a full cookie-parser dep if not already present) ─
function parseCookies(req) {
  const raw = req.headers.cookie || "";
  return raw.split(";").reduce((acc, part) => {
    const [k, ...v] = part.trim().split("=");
    if (k) acc[k.trim()] = decodeURIComponent(v.join("="));
    return acc;
  }, {});
}

// ─── PUBLIC: set session cookie after successful OAuth ─────────────────────────
/**
 * Call this in your OAuth callback route AFTER tokens are saved:
 *   setGmailSession(res, email)
 */
export function setGmailSession(res, email) {
  const id = createSession(email.toLowerCase().trim());
  const signed = makeSignedCookie(id);
  const isProd = process.env.NODE_ENV === "production";

  res.setHeader(
    "Set-Cookie",
    [
      `${SESSION_COOKIE}=${signed}`,
      `HttpOnly`,
      `Path=/`,
      `SameSite=Lax`,
      isProd ? `Secure` : "",
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ]
      .filter(Boolean)
      .join("; "),
  );

  console.log(
    ` Gmail session created for ${email} [session: ${id.slice(0, 8)}…]`,
  );
  return id;
}

// ─── PUBLIC: clear session cookie on disconnect ────────────────────────────────
export function clearGmailSession(req, res) {
  const cookies = parseCookies(req);
  const raw = cookies[SESSION_COOKIE];
  const id = parseSignedCookie(raw);
  if (id) destroySession(id);
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`,
  );
}

// ─── MIDDLEWARE 1: attachGmailSession ──────────────────────────────────────────
/**
 * Attaches req.gmailSession (or null) from the signed httpOnly cookie.
 * Does NOT block the request — call requireGmailAuth for that.
 *
 * Mount globally:  app.use(attachGmailSession)
 */
export function attachGmailSession(req, res, next) {
  const cookies = parseCookies(req);
  const raw = cookies[SESSION_COOKIE];
  const id = parseSignedCookie(raw);
  const session = id ? getSession(id) : null;

  req.gmailSessionId = id || null;
  req.gmailSession = session || null;

  // Convenience: the authoritative email for this request
  // NEVER falls back to req.body.email or req.query.email for security.
  req.gmailEmail = session ? session.gmailEmail : null;

  next();
}

// ─── MIDDLEWARE 2: requireGmailAuth ───────────────────────────────────────────
/**
 * Blocks the request with 401 if no valid session exists.
 * Also verifies the session email still has an active token in DB
 * (so a revoked / disconnected account can't continue using the API).
 *
 * Mount on Gmail router:  router.use(requireGmailAuth)
 *
 * Routes that should be PUBLIC (auth-url, oauth2callback, auth-status):
 * use `skipAuth` option or mount them BEFORE this middleware.
 */
export async function requireGmailAuth(req, res, next) {
  // ── Public endpoints that don't need a session ──
  const PUBLIC_PATHS = [
    "/auth-url",
    "/oauth2callback",
    "/auth-status",
    "/test",
  ];
  const path = req.path || "";
  if (PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + "?"))) {
    return next();
  }

  // ── Check session ──
  if (!req.gmailEmail) {
    return res.status(401).json({
      success: false,
      code: "NO_SESSION",
      message: "Not authenticated. Please connect your Gmail account.",
    });
  }

  // ── Verify token still exists and is active in DB ──
  try {
    const tokenDoc = await GmailToken.findOne({
      email: req.gmailEmail,
      is_active: true,
    }).lean();

    if (!tokenDoc) {
      // Token was revoked / disconnected — kill the session
      if (req.gmailSessionId) destroySession(req.gmailSessionId);
      return res.status(401).json({
        success: false,
        code: "TOKEN_REVOKED",
        message: "Gmail account disconnected. Please reconnect.",
      });
    }

    // All good — attach verified email for downstream use
    req.gmailEmail = tokenDoc.email; // already normalised
    return next();
  } catch (err) {
    console.error("requireGmailAuth DB error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Authentication check failed.",
    });
  }
}

// ─── MULTI-ACCOUNT: requireAccountAccess ─────────────────────────────────────
/**
 * Optional middleware for multi-account setups.
 *
 * When a user is allowed to manage MULTIPLE connected accounts, the client
 * may pass ?switchTo=other@gmail.com.  This middleware validates that:
 *   1. The requesting session owns OR has been granted access to that account.
 *   2. The target account has an active token.
 *
 * If no ?switchTo param, it simply uses the session email (default account).
 *
 * Security guarantee: you can ONLY switch to an account that was connected
 * from the SAME session (same browser session that did the OAuth).  Cross-user
 * switches are rejected.
 *
 * Mount AFTER requireGmailAuth on routes that support multi-account.
 */
export async function requireAccountAccess(req, res, next) {
  const requestedEmail = (req.query.switchTo || req.body?.switchTo || "")
    .toString()
    .toLowerCase()
    .trim();

  if (!requestedEmail || requestedEmail === req.gmailEmail) {
    // No switch requested — use the session's own account
    return next();
  }

  // Validate the session actually owns the requested account
  // (i.e., the same browser session connected it).
  const session = req.gmailSession;
  if (!session) {
    return res.status(401).json({ success: false, message: "No session." });
  }

  // A session can only own one email — reject cross-user switches
  if (session.gmailEmail !== requestedEmail) {
    console.warn(
      ` Account switch attempt blocked: session=${session.gmailEmail} → requested=${requestedEmail}`,
    );
    return res.status(403).json({
      success: false,
      code: "ACCOUNT_SWITCH_DENIED",
      message: "You do not have access to that Gmail account.",
    });
  }

  req.gmailEmail = requestedEmail;
  next();
}

// ─── HELPER: getEmailFromRequest ──────────────────────────────────────────────
/**
 * Safe replacement for the old `getEmail(req)` helper.
 *
 * Uses ONLY the session-verified email — never trusts client-supplied params.
 * Returns null (never throws) so routes can handle missing auth gracefully.
 */
export function getEmailFromRequest(req) {
  return req.gmailEmail || null;
}
