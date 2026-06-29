import express from "express";
import userRoutes from "./user.route.js";
import leadRoutes from "./leads.routes.js";
import roles from "./role.Routes.js";
import invoice from "./invoice.routes.js";

import activityRoutes from "./activity.routes.js";
import proposalRoutes from "./proposal.routes.js";
import dealsRoutes from "./deals.route.js";
import adminDashboard from "./adminDashboard.routes.js";
import notificationRoutes from "./notification.routes.js";
import salesRoutes from "./salesReports.routes.js"
import aiRoutes from "./ai.routes.js"; 
import streakRoutes from "./streak.routes.js"; 
import callLogRoutes from "./callLog.routes.js";
import botRoutes from "./bot.routes.js";
import clientLTVRoutes from "./clientLTVRoutes.js";
import contactFormRoutes from "./public.routes.js";
import emailTemplateRoutes from "./emailTemplate.routes.js";
import lostDealRoutes from "./lostDealRoutes.js";
import settingsRoutes from "./settingsRoutes.js";
import emailRoutes from "./email.routes.js"
import gmailRoutes from "./gmailRoutes.js"; 
import googleAuthRoutes from "./googleAuthRoutes.js";
import linkedinRoutes from "./linkedin.routes.js";
import justdialRoutes from "./justdial.routes.js";
import ninetyNineAcresRoutes from "./99acres.routes.js";
import sulekhaRoutes from "./sulekha.routes.js";
import meetingRoutes from "./meeting.routes.js";

const router = express.Router();

router.use("/users", userRoutes);
router.use("/leads", leadRoutes);

router.use("/deals", dealsRoutes);

router.use("/roles", roles);
router.use("/activity", activityRoutes);

router.use("/invoices", invoice);

router.use("/proposal", proposalRoutes);
router.use("/dashboard", adminDashboard);
// router.use("/notification", notificationRoutes);
router.use("/notifications", notificationRoutes);
router.use("/gmail", gmailRoutes); 
router.use("/google-auth", googleAuthRoutes); 
router.use("/sales", salesRoutes);
router.use("/ai", aiRoutes);
router.use("/streak", streakRoutes); 
router.use("/calllogs", callLogRoutes);
router.use("/bot", botRoutes);
router.use("/public", contactFormRoutes);
router.use("/email-templates", emailTemplateRoutes);
router.use("/lost-deals", lostDealRoutes);
router.use("/settings", settingsRoutes);
router.use("/client-ltv", clientLTVRoutes);
router.use("/email",emailRoutes);
router.use("/linkedin", linkedinRoutes);
router.use("/justdial", justdialRoutes);
router.use("/99acres", ninetyNineAcresRoutes);
router.use("/sulekha", sulekhaRoutes);
router.use("/meetings", meetingRoutes);

export default router;
