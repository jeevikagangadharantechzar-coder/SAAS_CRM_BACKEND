import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import fs from "fs";
import jwt from "jsonwebtoken";
import helmet from "helmet";
import mongoSanitize from "express-mongo-sanitize";
import rateLimit from "express-rate-limit";

// Meta webhook (public — must be before auth middleware)
import metaWebhookRoutes        from "./routes/metaWebhook.routes.js";
// LinkedIn webhook (public — must be before auth middleware)
import linkedinWebhookRoutes    from "./routes/linkedinWebhook.routes.js";


// Multi-tenant SaaS imports
import superAdminRoutes from "./routes/superAdmin.js";
import subscriptionPlanRoutes from "./routes/superadmin/subscriptionPlan.routes.js";
import freeTrialRoutes from "./routes/freeTrial.routes.js";
import tenantApiRouter from "./routes/tenantRouter.js";
import { resolveTenant } from "./middlewares/resolveTenant.js";
import { checkTrialExpiry } from "./middlewares/checkTrialExpiry.js";
import { activityLogger } from "./middlewares/activityLogger.middleware.js";

// Routes
import { startFollowUpCron } from "./controllers/followups.cron.js";
import gmailRoutes from "./routes/gmailRoutes.js";
import googleAuthRoutes from "./routes/googleAuthRoutes.js";
import zoomAuthRoutes from "./routes/zoomAuthRoutes.js";

import salesRoutes from "./routes/salesReports.routes.js";
import connectDB from "./config/db.js";
import routes from "./routes/index.routes.js";
import fileRoutes from "./routes/files.routes.js";
import callLogRoutes from "./routes/callLog.routes.js";
import botRoutes from "./routes/bot.routes.js";
import emailRoutes from "./routes/email.routes.js";
import templateRoutes from "./routes/emailTemplate.routes.js";
import publicRoutes from "./routes/public.routes.js";
import settingsRoutes from "./routes/settingsRoutes.js";
import lostDealRoutes from "./routes/lostDealRoutes.js";
import clientLTVRoutes from "./routes/clientLTVRoutes.js";
import notificationRoutes from "./routes/notification.routes.js";

// Unified notification cron
import "./cron/notificationCron.js";

// Target management cron (separate from the generic notification cron)
import "./cron/targetCron.js";

// Task management due-date reminder cron
import "./cron/taskCron.js";

// Socket
import { initSocket } from "./realtime/socket.js";
import { initSuperAdminSocket } from "./realtime/superAdminSocket.js";
import { initChatSocket } from "./realtime/chatSocket.js";

// Background jobs
import "./cron/emailCron.js";
import "./cron/subscriptionCron.js";
import "./cron/freeTrialCron.js";
import "./workers/emailWorker.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ─────────────────────────────────────────────
// CORS Configuration
// ─────────────────────────────────────────────
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:3000",
  "https://uenjoytours.cloud",
  "https://crm.stagingzar.com",
  "https://sales.stagingzar.com",
  "https://crm.techzarinfo.cloud",
  "https://tzicrm.com",
  "https://www.tzicrm.com"
];

if (process.env.FRONTEND_URL && !allowedOrigins.includes(process.env.FRONTEND_URL)) {
  allowedOrigins.push(process.env.FRONTEND_URL);
}

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    console.warn(`  CORS blocked: ${origin}`);
    return callback(new Error(`CORS policy: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"],
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// ─────────────────────────────────────────────
// Body parsers
// ─────────────────────────────────────────────
// For Meta webhook signature verification we need the raw body on /webhooks/meta
// All other routes use normal JSON parsing
app.use((req, res, next) => {
  if (req.path.startsWith("/webhooks/meta") || req.path.startsWith("/webhooks/linkedin")) {
    express.json({
      verify: (req, _res, buf) => { req.rawBody = buf; },
    })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});
app.use(express.urlencoded({ extended: true }));

// ─────────────────────────────────────────────
// Security & Sanitization
// ─────────────────────────────────────────────
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
  })
);
app.use(mongoSanitize());

// ─────────────────────────────────────────────
// Rate Limiting
// ─────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', globalLimiter);

// ─────────────────────────────────────────────
// Static files
// ─────────────────────────────────────────────
app.use(
  "/uploads",
  express.static(path.join(__dirname, "uploads"), {
    setHeaders: (res) => {
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("Access-Control-Allow-Origin", "*");
    },
  })
);
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────
// Public Webhook Routes (no auth — Meta calls these directly)
// ─────────────────────────────────────────────
app.use("/webhooks/meta", metaWebhookRoutes);
app.use("/webhooks/linkedin", linkedinWebhookRoutes);


// ─────────────────────────────────────────────
// Multi-tenant SaaS Routes  (mounted BEFORE existing /api routes)
// ─────────────────────────────────────────────
app.use("/superadmin", superAdminRoutes);
app.use("/api/superadmin/subscription-plans", subscriptionPlanRoutes);
app.use("/api/free-trial", freeTrialRoutes);
app.use("/:tenantSlug/api", resolveTenant, checkTrialExpiry, activityLogger(), tenantApiRouter);

// ─────────────────────────────────────────────
// Legacy / existing API Routes (single-tenant, kept for backward compat)
// ─────────────────────────────────────────────
app.use("/api", routes);
app.use("/api/files", fileRoutes);
app.use("/api/sales", salesRoutes);
app.use("/api/gmail", gmailRoutes);
app.use("/api/google-auth", googleAuthRoutes);
app.use("/api/zoom-auth", zoomAuthRoutes);
app.use("/api/deals", lostDealRoutes);
app.use("/api/cltv", clientLTVRoutes);
app.use("/api/calllogs", callLogRoutes);
app.use("/api/bot", botRoutes);
app.use("/api/email", emailRoutes);
app.use("/api/email-templates", templateRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/notification", notificationRoutes);

// Legacy Google callback
app.get("/api/auth/google/callback", (req, res) => {
  const redirectUrl = `/api/google-auth/auth/google/callback?${new URLSearchParams(req.query)}`;
  res.redirect(redirectUrl);
});

// ─────────────────────────────────────────────
// JWT Auth middleware for protected routes
// ─────────────────────────────────────────────
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ message: "Not authorized, no token" });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: "Token is not valid" });
    req.user = user;
    next();
  });
};

// Protected file download
app.get("/api/files/download", authenticateToken, (req, res) => {
  try {
    const { filePath } = req.query;
    if (!filePath) return res.status(400).json({ message: "File path is required" });

    const fullPath = path.join(__dirname, filePath);
    const uploadsDir = path.join(__dirname, "uploads");

    if (!fullPath.startsWith(uploadsDir)) return res.status(403).json({ message: "Access denied" });
    if (!fs.existsSync(fullPath)) return res.status(404).json({ message: "File not found" });

    const fileName = path.basename(fullPath);
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Type", "application/octet-stream");

    fs.createReadStream(fullPath).pipe(res);
  } catch (error) {
    console.error("File download error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// ─────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    service: "CRM Server",
    allowedOrigins
  });
});

// ─────────────────────────────────────────────
// 404 Handler
// ─────────────────────────────────────────────
app.use((req, res) => {
  console.log(` Not found: ${req.method} ${req.url}`);
  res.status(404).json({ message: "Route not found", path: req.url });
});

// ─────────────────────────────────────────────
// Error Handler
// ─────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  if (err.message?.startsWith("CORS policy")) {
    return res.status(403).json({ message: err.message });
  }
  console.error(" Server Error:", err.stack);
  res.status(500).json({
    message: "Server Error",
    error: process.env.NODE_ENV === "development" ? err.message : "Internal server error",
  });
});

// ─────────────────────────────────────────────
// Create HTTP Server
// ─────────────────────────────────────────────
const server = http.createServer(app);
initSocket(server);
initSuperAdminSocket();
initChatSocket();

// ─────────────────────────────────────────────
// Start Cron Jobs
// Unified notification cron is started by importing ./cron/notificationCron.js
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    await connectDB();
    console.log(" MongoDB connected");

    server.listen(PORT, () => {
      console.log(` Server running on port ${PORT}`);
      console.log(` WhatsApp webhook: POST http://localhost:${PORT}/api/whatsapp/webhook`);
      console.log(` WhatsApp status:  POST http://localhost:${PORT}/api/whatsapp/status`);
      console.log(` Allowed origins: ${allowedOrigins.join(", ")}`);
    });
  } catch (error) {
    console.error(" MongoDB connection failed:", error.message);
    process.exit(1);
  }
};

startServer();