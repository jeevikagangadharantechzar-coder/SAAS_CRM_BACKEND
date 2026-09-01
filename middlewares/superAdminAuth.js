import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import SuperAdmin from "../models/master/SuperAdmin.js";
// Referenced by SuperAdmin's `role` ref — must be registered before .populate("role") below.
import "../models/master/SuperAdminRole.js";
dotenv.config();

/**
 * Verifies the SuperAdmin JWT (signed with SUPERADMIN_JWT_SECRET) and attaches
 * the current account (with its role/permissions populated) as req.superAdmin.
 *
 * The account is re-fetched from the DB on every request rather than trusting
 * the JWT payload, so a role/permission change (or account deletion) takes
 * effect immediately instead of only after the token's 7-day expiry.
 */
export async function superAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.SUPERADMIN_JWT_SECRET);
    const admin = await SuperAdmin.findById(decoded.id).select("-password").populate("role");
    if (!admin) {
      return res.status(401).json({ error: "Invalid or expired superadmin token" });
    }
    req.superAdmin = admin;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired superadmin token" });
  }
}

/**
 * Gates a route behind one or more SuperAdminRole permission keys (OR logic —
 * passes if the role has ANY of the given keys). Must run after superAdminAuth.
 * An account with no role assigned (role: null) has zero permissions.
 */
export const requireSuperAdminPermission = (...keys) => (req, res, next) => {
  const permissions = req.superAdmin?.role?.permissions || {};
  if (keys.some((key) => permissions[key])) return next();
  return res.status(403).json({ success: false, error: "Access denied: your role does not have permission for this feature" });
};
