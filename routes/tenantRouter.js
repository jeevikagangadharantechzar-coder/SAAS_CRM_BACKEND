/**
 * tenantRouter — mounts all existing routers under /:tenantSlug/api/
 *
 * resolveTenant middleware (applied in app.js before this router) has already
 * set req.tenant and req.tenantDB before any handler runs.
 *
 * All route paths match the original /api/... surface, just scoped per-tenant.
 */
import express from "express";

import userRoutes          from "./user.route.js";
import leadRoutes          from "./leads.routes.js";
import dealsRoutes         from "./deals.route.js";
import roles               from "./role.Routes.js";
import activityRoutes      from "./activity.routes.js";
import invoice             from "./invoice.routes.js";
import proposalRoutes      from "./proposal.routes.js";
import adminDashboard      from "./adminDashboard.routes.js";
import notificationRoutes  from "./notification.routes.js";
import gmailRoutes         from "./gmailRoutes.js";
import googleAuthRoutes    from "./googleAuthRoutes.js";
import salesRoutes         from "./salesReports.routes.js";
import aiRoutes            from "./ai.routes.js";
import streakRoutes        from "./streak.routes.js";
import callLogRoutes       from "./callLog.routes.js";
import botRoutes           from "./bot.routes.js";
import clientLTVRoutes     from "./clientLTVRoutes.js";
import emailTemplateRoutes from "./emailTemplate.routes.js";
import lostDealRoutes      from "./lostDealRoutes.js";
import settingsRoutes      from "./settingsRoutes.js";
import emailRoutes         from "./email.routes.js";

import fileRoutes          from "./files.routes.js";
import metaRoutes          from "./meta.routes.js";
import linkedinRoutes      from "./linkedin.routes.js";
import taskRoutes          from "./task.routes.js";
import targetRoutes        from "./target.routes.js";
import chatRoutes          from "./chat.routes.js";
import justdialRoutes      from "./justdial.routes.js";
import indiamartRoutes      from "./indiamart.routes.js";
import ninetyNineAcresRoutes from "./99acres.routes.js";
import sulekhaRoutes       from "./sulekha.routes.js";
import meetingRoutes            from "./meeting.routes.js";
import googleIntegrationRoutes  from "./googleIntegration.routes.js";


const router = express.Router();

router.use("/users",           userRoutes);
router.use("/leads",           leadRoutes);
router.use("/deals",           dealsRoutes);
router.use("/roles",           roles);
router.use("/activity",        activityRoutes);
router.use("/invoices",        invoice);
router.use("/proposal",        proposalRoutes);
router.use("/dashboard",       adminDashboard);
router.use("/notifications",   notificationRoutes);
router.use("/gmail",           gmailRoutes);
router.use("/google-auth",     googleAuthRoutes);
router.use("/sales",           salesRoutes);
router.use("/ai",              aiRoutes);
router.use("/streak",          streakRoutes);
router.use("/calllogs",        callLogRoutes);
router.use("/bot",             botRoutes);
router.use("/client-ltv",      clientLTVRoutes);
router.use("/cltv",            clientLTVRoutes);
router.use("/email-templates", emailTemplateRoutes);
router.use("/lost-deals",      lostDealRoutes);
router.use("/deals",           lostDealRoutes);
router.use("/settings",        settingsRoutes);
router.use("/email",           emailRoutes);

router.use("/files",           fileRoutes);
router.use("/meta",            metaRoutes);
router.use("/linkedin",        linkedinRoutes);
router.use("/tasks",           taskRoutes);
router.use("/targets",         targetRoutes);
router.use("/chat",            chatRoutes);
router.use("/justdial",        justdialRoutes);
router.use("/indiamart",        indiamartRoutes);
router.use("/99acres",         ninetyNineAcresRoutes);
router.use("/sulekha",         sulekhaRoutes);
router.use("/meetings",           meetingRoutes);
router.use("/google-integration", googleIntegrationRoutes);


export default router;
