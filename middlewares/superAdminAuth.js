import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();

/**
 * Verifies the SuperAdmin JWT (signed with SUPERADMIN_JWT_SECRET).
 * Attaches req.superAdmin = decoded payload on success.
 */
export async function superAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.SUPERADMIN_JWT_SECRET);
    req.superAdmin = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired superadmin token" });
  }
}
