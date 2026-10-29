import rateLimit from "express-rate-limit";

/**
 * Strict rate limiter for authentication routes (login, forgot password, MFA).
 * Allows 10 attempts per 15 minutes per IP.
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many attempts from this IP. Please try again after 15 minutes.",
    code: "RATE_LIMIT_EXCEEDED",
  },
});

/**
 * Moderate rate limiter for password reset endpoints.
 * Allows 5 attempts per 15 minutes per IP.
 */
export const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many password reset requests. Please try again after 15 minutes.",
    code: "RATE_LIMIT_EXCEEDED",
  },
});
