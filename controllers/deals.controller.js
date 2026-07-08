import sendEmail from "../services/email.js";
import { sendEmailWithAttachments } from "../utils/gmailService.js";
import { notifyUser } from "../realtime/socket.js";
import clientLTVController from "./clientLTVController.js";
import { getTenantModels } from "../models/tenant/index.js";
import SettingsLegacy from "../models/Settings.js";
import {
  deleteNotificationsByEntity,
  deleteAllNotificationsByEntity,
  sendNotification,
  sendNotificationToAdmins,
} from "../services/notificationService.js";
import {
  notifyLeadConvertedByAdmin,
  notifyLeadOrDealEdited,
  notifyDealClosedWonAndArchiveTask,
  notifyDealStageChangedByAdmin,
} from "../services/taskNotificationService.js";

// Legacy fallbacks
import DealLegacy         from "../models/deals.model.js";
import LeadLegacy         from "../models/leads.model.js";
import NotificationLegacy from "../models/notification.model.js";

const getModels = (req) => {
  if (req.tenantDB) return getTenantModels(req.tenantDB);
  return { Deal: DealLegacy, Lead: LeadLegacy, Notification: NotificationLegacy };
};

const getSettings = (req) =>
  req.tenantDB ? getTenantModels(req.tenantDB).Settings : SettingsLegacy;

// Notify the client themselves once their deal is marked Closed Won. Uses the
// tenant's connected Gmail (Settings.invoiceSenderEmail) when available, same
// as proposals/invoices, so it doesn't send from the generic shared mailbox.
const sendClosedWonEmail = async (req, deal) => {
  if (!deal.email) return;
  try {
    const Settings = getSettings(req);
    const settings = await Settings.findOne();
    const companyName = settings?.companyName || req.tenant?.name || "CRM Software";
    const subject = `Congratulations! "${deal.dealName}" is now closed`;
    const html = `
      <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#333;max-width:600px;margin:auto;">
        <p>Hi,</p>
        <p>We're happy to let you know that your deal <strong>${deal.dealName}</strong> has been marked as <strong>Closed Won</strong>.</p>
        <p>Thank you for choosing ${companyName}. We look forward to working with you.</p>
      </div>
    `;
    if (settings?.invoiceSenderEmail) {
      await sendEmailWithAttachments(deal.email, subject, html, "", "", [], [], settings.invoiceSenderEmail);
    } else {
      await sendEmail({ to: deal.email, subject, html });
    }
  } catch (err) {
    console.error("Closed Won email error:", err.message);
  }
};

const mapFileToAttachment = (file) => ({
  name: file.originalname,
  path: file.path.replace(/\\/g, "/").replace(/^\/+/, ""),
  type: file.mimetype, size: file.size, uploadedAt: new Date(),
});

const normalizeAttachment = (att) => {
  if (!att) return null;
  if (typeof att === "string") {
    const cleanPath = att.replace(/^\/+/, "");
    return { name: cleanPath.split("/").pop() || "file", path: cleanPath, type: "application/octet-stream", size: 0, uploadedAt: new Date() };
  }
  return { _id: att._id, name: att.name || att.path?.split("/").pop() || "file",
    path: (att.path || "").replace(/^\/+/, ""), type: att.type || "application/octet-stream",
    size: att.size || 0, uploadedAt: att.uploadedAt || new Date() };
};

const formatDealValue = (dealValue, currency = "INR") => {
  const numeric = Number(String(dealValue).replace(/,/g, ""));
  if (isNaN(numeric)) return "0";
  return `${new Intl.NumberFormat("en-IN").format(numeric)} ${currency}`;
};

export default {
  createDealFromLead: async (req, res) => {
    try {
      const models = getModels(req);
      const { Lead, Deal } = models;
      const lead = await Lead.findById(req.params.leadId).populate("assignTo");
      if (!lead) return res.status(404).json({ message: "Lead not found" });
      if (lead.status === "Converted") return res.status(400).json({ message: "Lead already converted" });

      lead.status = "Converted"; lead.followUpDate = null; lead.lastReminderAt = null;
      await lead.save();

      const deal = new Deal({
        leadId: lead._id,
        dealName: lead.leadName,
        assignedTo: lead.assignTo?._id,
        stage: "Qualification",
        value: "0",
        destination: lead.destination || "",
        duration: lead.duration || "",
        clientType: lead.clientType || null,
      });
      await deal.save();

      if (req.user.role?.name === "Admin") {
        notifyLeadConvertedByAdmin(models, { lead, deal, actorId: req.user._id }).catch((err) => console.error("notifyLeadConvertedByAdmin error:", err));
      }

      res.status(200).json({ message: "Lead converted to deal", deal });
    } catch (err) { res.status(500).json({ message: err.message }); }
  },

  createManualDeal: async (req, res) => {
    try {
      const models = getModels(req);
      const { Deal, Notification } = models;
      const tDB = req.tenantDB || null;
      const {
        dealName, assignTo, dealValue, currency, stage, notes, phoneNumber, email,
        source, companyName, companyId, industry, requirement, address, country,
        followUpDate, followUpComment, lossReason, lossNotes, clientType,
        preferredCurrency, preferredCurrencyValue,
      } = req.body;

      if (!dealName || !phoneNumber || !companyName)
        return res.status(400).json({ message: "dealName, phoneNumber & companyName are required" });

      const allowedStages = ["Qualification","Proposal Sent-Negotiation","Invoice Sent","Closed Won","Closed Lost"];
      const dealStage = stage && allowedStages.includes(stage) ? stage : "Qualification";
      const formattedValue = dealValue && String(dealValue).trim() !== "" ? formatDealValue(dealValue, currency || "INR") : "0";

      let parsedFollowUpDate = null;
      let followUpHistory   = [];
      if (followUpDate) {
        parsedFollowUpDate = new Date(followUpDate);
        if (isNaN(parsedFollowUpDate.getTime())) return res.status(400).json({ message: "Invalid follow-up date format" });
        followUpHistory = [{ date: new Date(), followUpDate: parsedFollowUpDate, followUpComment: followUpComment || "", changedBy: req.user._id, action: "Created" }];
      }

      const attachments = (req.files || []).map(mapFileToAttachment);
      const deal = new Deal({
        dealName,
        assignedTo: assignTo || null,
        value: formattedValue,
        currency: currency || "INR",
        stage: dealStage,
        notes: notes || "",
        phoneNumber,
        email: email || "",
        source: source || "",
        companyName: companyName || "",
        companyId: companyId || null,
        industry: industry || "",
        requirement: requirement || "",
        address: address || "",
        country: country || "",
        clientType: clientType || null,
        preferredCurrency: preferredCurrency || null,
        preferredCurrencyValue: preferredCurrencyValue ? parseFloat(preferredCurrencyValue) : null,
        followUpDate: parsedFollowUpDate,
        followUpComment: followUpComment || "",
        followUpHistory,
        lossReason: lossReason || "",
        lossNotes: lossNotes || "",
        attachments,
        // Record the starting stage so the journey view isn't missing steps
        // when a deal is created directly at a later stage (e.g. Closed Won).
        stageHistory: [{ stage: dealStage, movedAt: new Date(), movedBy: req.user._id }],
        ...(dealStage === "Closed Won" && { wonAt: new Date(), wonBy: req.user._id }),
        ...(dealStage === "Closed Lost" && { stageLostAt: "Qualification", lostDate: new Date() }),
      });
      await deal.save();

      if (assignTo && req.user.role?.name === "Admin" && String(assignTo) !== String(req.user._id)) {
        const adminName = `${req.user.firstName || ""} ${req.user.lastName || ""}`.trim() || "Admin";
        Notification.create({
          userId: assignTo,
          createdBy: req.user._id,
          type: "task",
          title: `New Deal Assigned by Admin ${adminName}`,
          message: `Admin ${adminName} assigned you a new deal: "${deal.dealName}"`,
          text: `Admin ${adminName} assigned you a new deal: "${deal.dealName}"`,
          referenceId: String(deal._id),
          meta: { dealAssigned: true, dealId: String(deal._id), dealName: deal.dealName, adminName },
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          read: false,
          isRead: false,
        }).catch((err) => console.error("New deal assigned notification error:", err));
      }

      if (parsedFollowUpDate) {
        if (assignTo) await sendNotification(assignTo, `Deal follow-up scheduled: ${deal.dealName}`, "followup",
          { dealId: deal._id, dealName: deal.dealName, profileImage: null }, { title: "Deal Follow-up", followUpDate: deal.followUpDate }, tDB);
        await sendNotificationToAdmins(`Deal follow-up scheduled: ${deal.dealName}`, "followup",
          { dealId: deal._id, dealName: deal.dealName, profileImage: null },
          { title: "Deal Follow-up", followUpDate: deal.followUpDate }, assignTo ? [assignTo] : [], tDB);
      }
      res.status(201).json({ message: "Manual deal created", deal });
    } catch (err) { console.error("Error creating manual deal:", err); res.status(500).json({ message: err.message }); }
  },

  getAllDeals: async (req, res) => {
    try {
      const { Deal } = getModels(req);
      const isAdmin = req.user.role.name === "Admin";
      let query = {};
      if (!isAdmin) query.assignedTo = req.user._id;

      // Rejected deals always live on the dedicated Reject Deals page instead —
      // never in the main list, for anyone (including Admin). Closed Won deals
      // DO stay in the sales person's own list — it's their own deal, whether
      // they or Admin closed it, and there's no separate "Won Deals" page for
      // them to see it on otherwise.
      query.stage = { $nin: ["Rejected"] };

      const { start, end } = req.query;
      const dealTypes = (req.query.dealType || "").split(",").map((s) => s.trim()).filter(Boolean);

      if (start && end) {
        const rangeStart = new Date(start);
        const rangeEnd = new Date(end + "T23:59:59.999Z");
        if (dealTypes.length) {
          // Custom Range search (sales "Custom Range" panel): match each
          // ticked type against its own meaningful date field — wonAt/lostDate
          // for Won/Lost, createdAt for still-open Pending deals — instead of
          // just createdAt, so e.g. a deal created weeks ago but won this week
          // still matches a "Deal Won" search for this week.
          const orConditions = [];
          if (dealTypes.includes("won")) orConditions.push({ stage: "Closed Won", wonAt: { $gte: rangeStart, $lte: rangeEnd } });
          if (dealTypes.includes("lost")) orConditions.push({ stage: "Closed Lost", lostDate: { $gte: rangeStart, $lte: rangeEnd } });
          if (dealTypes.includes("pending")) orConditions.push({ stage: { $nin: ["Closed Won", "Closed Lost", "Rejected"] }, createdAt: { $gte: rangeStart, $lte: rangeEnd } });
          query.$or = orConditions;
        } else {
          query.createdAt = { $gte: rangeStart, $lte: rangeEnd };
        }
      } else if (!isAdmin) {
        // Default (non-search) fetch for a sales person: previous-day Closed
        // Won / Closed Lost deals stay out of the list — only today's wins
        // and losses show at initial render. Older ones are only reachable
        // through the Custom Range search above. Pending (still-open) deals
        // always show regardless of age.
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
        query.$or = [
          { stage: { $nin: ["Closed Won", "Closed Lost"] } },
          { stage: "Closed Won", wonAt: { $gte: todayStart, $lte: todayEnd } },
          { stage: "Closed Lost", lostDate: { $gte: todayStart, $lte: todayEnd } },
        ];
      }

      const deals = await Deal.find(query)
        .populate("assignedTo", "firstName lastName email")
        .populate("rejectedBy", "firstName lastName")
        .populate({ path: "wonBy", select: "firstName lastName role", populate: { path: "role", select: "name" } })
        .populate({ path: "convertedBy", select: "firstName lastName role", populate: { path: "role", select: "name" } })
        .sort({ createdAt: -1 });
      res.status(200).json(deals);
    } catch (err) { console.error(err); res.status(500).json({ message: err.message }); }
  },

  getDealById: async (req, res) => {
    try {
      const { Deal } = getModels(req);
      const deal = await Deal.findById(req.params.id)
        .populate("assignedTo", "firstName lastName email")
        .populate("followUpHistory.changedBy", "firstName lastName email")
        .populate({ path: "leadId", populate: { path: "assignTo", select: "firstName lastName email" } });

      if (!deal) return res.status(404).json({ message: "Deal not found" });
      if (req.user.role.name !== "Admin" && deal.assignedTo && deal.assignedTo._id.toString() !== req.user._id.toString())
        return res.status(403).json({ message: "Access denied: You can only view deals assigned to you" });

      const leadAttachments = deal.leadId?.attachments || [];
      const allAttachments  = [
        ...leadAttachments.map(att => ({ name: typeof att === "string" ? att.split("/").pop() : (att.name || att.path?.split("/").pop() || "file"),
          path: typeof att === "string" ? att : (att.path || ""), type: "lead", size: att.size || 0, uploadedAt: att.uploadedAt || null })),
        ...(deal.attachments || []).map(att => ({ name: att.name || att.path?.split("/").pop() || "file",
          path: att.path || "", type: "deal", size: att.size || 0, uploadedAt: att.uploadedAt || null })),
      ];

      res.status(200).json({ ...deal.toObject(), attachments: allAttachments });
    } catch (err) { console.error("Get deal by ID error:", err); res.status(500).json({ message: err.message }); }
  },

  updateStage: async (req, res) => {
    try {
      const { Deal } = getModels(req);
      const { stage } = req.body;
      const allowedStages = ["Qualification","Proposal Sent-Negotiation","Invoice Sent","Closed Won","Closed Lost"];
      if (!allowedStages.includes(stage)) return res.status(400).json({ message: "Invalid stage" });

      const deal = await Deal.findById(req.params.id).populate("assignedTo", "email");
      if (!deal) return res.status(404).json({ message: "Deal not found" });
      if (req.user.role.name !== "Admin" && deal.assignedTo._id.toString() !== req.user._id.toString())
        return res.status(403).json({ message: "Access denied: You can only update deals assigned to you" });

      const previousStage = deal.stage;
      deal.stage = stage;
      if (stage === "Closed Lost" && previousStage !== "Closed Lost") {
        deal.stageLostAt = previousStage;
        deal.lostDate = new Date();
      } else if (stage !== "Closed Lost" && previousStage === "Closed Lost") {
        deal.stageLostAt = null;
        deal.lostDate = null;
      }
      if (!deal.stageHistory) deal.stageHistory = [];
      // Always record stage moves for full journey tracking (admin + salesperson)
      deal.stageHistory.push({ stage, movedAt: new Date(), movedBy: req.user._id });

      if (stage === "Closed Won" && previousStage !== "Closed Won") {
        deal.wonAt = new Date();
        deal.wonBy = req.user._id;
      } else if (previousStage === "Closed Won" && stage !== "Closed Won") {
        deal.wonAt = null;
        deal.wonBy = null;
      }

      await deal.save();

      const isAdmin = req.user.role.name === "Admin";

      if (stage === "Closed Won" && previousStage !== "Closed Won" && deal.companyName?.trim())
        clientLTVController.calculateClientCLV(deal.companyName).catch(err => console.error("Background CLV recalculation error:", err));

      if (stage === "Closed Won" && previousStage !== "Closed Won") {
        notifyDealClosedWonAndArchiveTask(getModels(req), { deal, actorId: req.user._id, isAdminActor: isAdmin })
          .catch(err => console.error("notifyDealClosedWonAndArchiveTask error:", err));
        sendClosedWonEmail(req, deal).catch(err => console.error("sendClosedWonEmail error:", err));
      }

      // Notify admins + the assigned sales person so targets refresh live
      // (transient socket signal only — the persistent notification for an
      // admin-driven stage move is created once, below, via
      // notifyDealStageChangedByAdmin, so it's not duplicated here).
      try {
        const { User, Role } = getModels(req);
        const adminRole = await Role.findOne({ name: "Admin" });
        const payload = {
          dealId: String(deal._id),
          dealName: deal.dealName,
          stage,
          previousStage,
          updatedBy: `${req.user.firstName} ${req.user.lastName}`,
        };
        if (adminRole) {
          const admins = await User.find({ role: adminRole._id, status: "Active" }).select("_id");
          admins.forEach(a => notifyUser(String(a._id), "deal_stage_updated", payload));
        }
        // Also notify the sales person assigned to this deal
        const spId = deal.assignedTo ? String(deal.assignedTo._id || deal.assignedTo) : null;
        if (spId) {
          notifyUser(spId, "deal_stage_updated", payload);
        }
      } catch (_) {}

      if (stage !== "Closed Won" && stage !== previousStage) {
        notifyDealStageChangedByAdmin(getModels(req), { deal, stage, previousStage, actorId: req.user._id })
          .catch(err => console.error("notifyDealStageChangedByAdmin error:", err));
      }

      res.status(200).json(deal);
    } catch (err) { res.status(500).json({ message: err.message }); }
  },

  updateDeal: async (req, res) => {
    try {
      const { Deal } = getModels(req);
      const tDB = req.tenantDB || null;
      const {
        dealName, dealValue, currency, stage, assignTo, notes, phoneNumber, email, source,
        companyName, companyId, industry, requirement, address, country, existingAttachments,
        followUpDate, followUpComment, lossReason, lossNotes, clientType,
      } = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

      const deal = await Deal.findById(req.params.id).populate("assignedTo");
      if (!deal) return res.status(404).json({ message: "Deal not found" });
      if (req.user.role.name !== "Admin" && deal.assignedTo?._id.toString() !== req.user._id.toString())
        return res.status(403).json({ message: "Access denied" });

      const allowedStages = ["Qualification","Proposal Sent-Negotiation","Invoice Sent","Closed Won","Closed Lost"];
      if (stage && !allowedStages.includes(stage)) return res.status(400).json({ message: "Invalid stage" });

      const oldFollowUpDate = deal.followUpDate;
      const newFollowUpDateParsed = followUpDate ? new Date(followUpDate) : null;
      const followUpChanged = oldFollowUpDate?.toDateString() !== newFollowUpDateParsed?.toDateString();

      const updateFields = {
        ...(dealName    && { dealName }),
        ...(assignTo    && { assignedTo: assignTo }),
        ...(stage       && { stage }),
        ...(notes       !== undefined && { notes }),
        ...(phoneNumber && { phoneNumber }),
        ...(email       !== undefined && { email }),
        ...(source      !== undefined && { source }),
        ...(companyName && { companyName }),
        ...(companyId   !== undefined && { companyId }),
        ...(industry    !== undefined && { industry }),
        ...(requirement !== undefined && { requirement }),
        ...(address     !== undefined && { address }),
        ...(country     !== undefined && { country }),
        ...(lossReason  !== undefined && { lossReason }),
        ...(lossNotes   !== undefined && { lossNotes }),
        ...(clientType  !== undefined && { clientType }),
        updatedAt: new Date(),
      };

      if (stage === "Closed Lost" && deal.stage !== "Closed Lost") { updateFields.stageLostAt = deal.stage; updateFields.lostDate = new Date(); }
      if (deal.stage === "Closed Lost" && stage && stage !== "Closed Lost") { updateFields.stageLostAt = null; updateFields.lostDate = null; }
      if (stage === "Closed Won" && deal.stage !== "Closed Won") { updateFields.wonAt = new Date(); updateFields.wonBy = req.user._id; }
      if (deal.stage === "Closed Won" && stage && stage !== "Closed Won") { updateFields.wonAt = null; updateFields.wonBy = null; }
      if (stage && stage !== deal.stage) {
        // Always record stage moves for full journey tracking (admin + salesperson)
        updateFields.$push = { stageHistory: { stage, movedAt: new Date(), movedBy: req.user._id } };
      }
      if (dealValue !== undefined && dealValue !== null && String(dealValue).trim() !== "") {
        updateFields.value = formatDealValue(dealValue, currency || deal.currency || "INR");
        updateFields.currency = currency || deal.currency || "INR";
      }

      let hasFollowUpChanged = false;
      if (followUpDate !== undefined) {
        let nfud = followUpDate ? new Date(followUpDate) : null;
        if (nfud && isNaN(nfud.getTime())) return res.status(400).json({ message: "Invalid follow-up date format" });
        updateFields.followUpDate = nfud;
        if ((oldFollowUpDate?.toISOString() || null) !== (nfud?.toISOString() || null)) hasFollowUpChanged = true;
      }
      if (followUpComment !== undefined) {
        updateFields.followUpComment = followUpComment;
        if (deal.followUpComment !== followUpComment) hasFollowUpChanged = true;
      }
      if (hasFollowUpChanged) {
        updateFields.lastReminderAt = null;
        updateFields.followUpHistory = [...(deal.followUpHistory || []),
          { date: new Date(), followUpDate: updateFields.followUpDate || null,
            followUpComment: updateFields.followUpComment || "", changedBy: req.user._id,
            action: oldFollowUpDate ? "Updated" : "Created" }];
      }

      let keptAttachments = [];
      if (existingAttachments !== undefined) {
        try {
          const parsed = typeof existingAttachments === "string" ? JSON.parse(existingAttachments) : existingAttachments;
          keptAttachments = (Array.isArray(parsed) ? parsed : []).map(normalizeAttachment).filter(Boolean);
        } catch { keptAttachments = (deal.attachments || []).map(normalizeAttachment).filter(Boolean); }
      } else {
        keptAttachments = (deal.attachments || []).map(normalizeAttachment).filter(Boolean);
      }
      updateFields.attachments = [...keptAttachments, ...(req.files || []).map(mapFileToAttachment)];

      const updatedDeal = await Deal.findByIdAndUpdate(req.params.id, updateFields, { new: true })
        .populate("assignedTo", "firstName lastName email")
        .populate("followUpHistory.changedBy", "firstName lastName email");

      if (followUpChanged) {
        await deleteAllNotificationsByEntity("deal", req.params.id, tDB);
        const assignedUserId = deal.assignedTo?._id || deal.assignedTo || null;
        if (assignedUserId)
          await sendNotification(assignedUserId, `Deal follow-up scheduled: ${updatedDeal.dealName}`, "followup",
            { dealId: updatedDeal._id, dealName: updatedDeal.dealName, profileImage: updatedDeal.assignedTo?.profileImage },
            { title: "Deal Follow-up", followUpDate: updatedDeal.followUpDate }, tDB);
        await sendNotificationToAdmins(`Deal follow-up scheduled: ${updatedDeal.dealName}`, "followup",
          { dealId: updatedDeal._id, dealName: updatedDeal.dealName, profileImage: updatedDeal.assignedTo?.profileImage },
          { title: "Deal Follow-up", followUpDate: updatedDeal.followUpDate },
          assignedUserId ? [assignedUserId] : [], tDB);
      }

      if (stage === "Closed Won" && deal.stage !== "Closed Won" && updatedDeal.companyName?.trim())
        clientLTVController.calculateClientCLV(updatedDeal.companyName).catch(err => console.error("Background CLV recalculation error:", err));

      if (stage === "Closed Won" && deal.stage !== "Closed Won") {
        notifyDealClosedWonAndArchiveTask(getModels(req), { deal: updatedDeal, actorId: req.user._id, isAdminActor: req.user.role.name === "Admin" })
          .catch(err => console.error("notifyDealClosedWonAndArchiveTask error:", err));
        sendClosedWonEmail(req, updatedDeal).catch(err => console.error("sendClosedWonEmail error:", err));
      }

      // Admin edited general details (not just stage/follow-up) — notify the assignee
      if (req.user.role.name === "Admin") {
        const coreEditPairs = [
          [dealName, deal.dealName], [phoneNumber, deal.phoneNumber], [email, deal.email],
          [companyName, deal.companyName], [industry, deal.industry], [requirement, deal.requirement],
          [address, deal.address], [country, deal.country],
        ];
        const hasCoreEdit = coreEditPairs.some(([next, prev]) => next !== undefined && String(next) !== String(prev || ""));
        if (hasCoreEdit) {
          const adminName = `${req.user.firstName || ""} ${req.user.lastName || ""}`.trim() || "Admin";
          notifyLeadOrDealEdited(getModels(req), { itemType: "deal", item: updatedDeal, actorId: req.user._id, adminName })
            .catch(err => console.error("notifyLeadOrDealEdited error:", err));
        }
      }

      // Notify admins + assigned sales person so targets refresh live
      // (transient socket signal only — the persistent notification for an
      // admin-driven stage move is created once, below).
      if (stage && stage !== deal.stage) {
        try {
          const { User, Role } = getModels(req);
          const adminRole = await Role.findOne({ name: "Admin" });
          const payload2 = {
            dealId: String(updatedDeal._id),
            dealName: updatedDeal.dealName,
            stage,
            previousStage: deal.stage,
            updatedBy: `${req.user.firstName} ${req.user.lastName}`,
          };
          if (adminRole) {
            const admins = await User.find({ role: adminRole._id, status: "Active" }).select("_id");
            admins.forEach(a => notifyUser(String(a._id), "deal_stage_updated", payload2));
          }
          if (updatedDeal.assignedTo) {
            notifyUser(String(updatedDeal.assignedTo._id || updatedDeal.assignedTo), "deal_stage_updated", payload2);
          }
        } catch (_) {}

        if (stage !== "Closed Won") {
          notifyDealStageChangedByAdmin(getModels(req), { deal: updatedDeal, stage, previousStage: deal.stage, actorId: req.user._id })
            .catch(err => console.error("notifyDealStageChangedByAdmin error:", err));
        }
      }

      res.status(200).json({ message: "Deal updated successfully", deal: updatedDeal });
    } catch (err) { console.error("Update deal error:", err); res.status(500).json({ message: err.message }); }
  },

  completeFollowUp: async (req, res) => {
    try {
      const { Deal } = getModels(req);
      const { id } = req.params;
      const { outcome, notes } = req.body;
      const deal = await Deal.findById(id);
      if (!deal) return res.status(404).json({ message: "Deal not found" });
      if (req.user.role.name !== "Admin" && deal.assignedTo?.toString() !== req.user._id.toString())
        return res.status(403).json({ message: "Access denied" });
      if (!deal.followUpDate) return res.status(400).json({ message: "No active follow-up to complete" });

      const updatedDeal = await Deal.findByIdAndUpdate(id, {
        followUpDate: null, followUpComment: "",
        followUpHistory: [...(deal.followUpHistory || []),
          { date: new Date(), followUpDate: deal.followUpDate, followUpComment: deal.followUpComment,
            changedBy: req.user._id, action: "Completed", outcome: outcome || "Completed", notes: notes || "" }],
        updatedAt: new Date(),
      }, { new: true })
        .populate("assignedTo", "firstName lastName email")
        .populate("followUpHistory.changedBy", "firstName lastName email");

      res.status(200).json({ message: "Follow-up completed successfully", deal: updatedDeal });
    } catch (err) { console.error("Complete follow-up error:", err); res.status(500).json({ message: err.message }); }
  },

  scheduleFollowUp: async (req, res) => {
    try {
      const { Deal } = getModels(req);
      const tDB = req.tenantDB || null;
      const { id } = req.params;
      const { followUpDate, followUpComment, previousOutcome, previousNotes } = req.body;
      const deal = await Deal.findById(id).populate("assignedTo");
      if (!deal) return res.status(404).json({ message: "Deal not found" });

      const assignedToId = deal.assignedTo?._id?.toString() || deal.assignedTo?.toString();
      if (req.user.role.name !== "Admin" && assignedToId !== req.user._id.toString())
        return res.status(403).json({ message: "Access denied" });
      if (!followUpDate) return res.status(400).json({ message: "Follow-up date is required" });

      if (deal.followUpDate && (!previousOutcome || !previousNotes)) {
        return res.status(400).json({ message: "Previous outcome and notes are required to reschedule" });
      }

      const parsedDate = new Date(followUpDate);
      if (isNaN(parsedDate.getTime())) return res.status(400).json({ message: "Invalid date format" });

      const newHistory = [...(deal.followUpHistory || [])];

      // Mark the old follow-up as completed/missed using the user provided outcome
      if (deal.followUpDate) {
        newHistory.push({
          date: new Date(),
          followUpDate: deal.followUpDate,
          followUpComment: deal.followUpComment || "",
          changedBy: req.user._id,
          action: "Completed",
          outcome: previousOutcome,
          notes: previousNotes
        });
      }

      // Add the newly scheduled follow-up
      newHistory.push({
        date: new Date(),
        followUpDate: parsedDate,
        followUpComment: followUpComment || "",
        changedBy: req.user._id,
        action: "Scheduled"
      });

      const updatedDeal = await Deal.findByIdAndUpdate(id, {
        followUpDate: parsedDate, followUpComment: followUpComment || "",
        lastReminderAt: null,
        followUpHistory: newHistory,
      }, { new: true })
        .populate("assignedTo", "firstName lastName email")
        .populate("followUpHistory.changedBy", "firstName lastName email");

      await deleteAllNotificationsByEntity("deal", id, tDB);
      const assignedUserId = deal.assignedTo?._id || deal.assignedTo || null;
      if (assignedUserId)
        await sendNotification(assignedUserId, `Deal follow-up scheduled: ${updatedDeal.dealName}`, "followup",
          { dealId: updatedDeal._id, dealName: updatedDeal.dealName, profileImage: updatedDeal.assignedTo?.profileImage },
          { title: "Deal Follow-up", followUpDate: updatedDeal.followUpDate }, tDB);
      await sendNotificationToAdmins(`Deal follow-up scheduled: ${updatedDeal.dealName}`, "followup",
        { dealId: updatedDeal._id, dealName: updatedDeal.dealName, profileImage: updatedDeal.assignedTo?.profileImage },
        { title: "Deal Follow-up", followUpDate: updatedDeal.followUpDate },
        assignedUserId ? [assignedUserId] : [], tDB);

      res.status(200).json({ message: "Follow-up scheduled successfully", deal: updatedDeal });
    } catch (err) { console.error("Schedule follow-up error:", err); res.status(500).json({ message: err.message }); }
  },

  deleteDeal: async (req, res) => {
    try {
      const { Deal, Notification } = getModels(req);
      const tDB = req.tenantDB || null;
      const { id } = req.params;
      const deal = await Deal.findById(id).populate("assignedTo");
      if (!deal) return res.status(404).json({ message: "Deal not found" });
      if (req.user.role.name !== "Admin" && deal.assignedTo._id.toString() !== req.user._id.toString())
        return res.status(403).json({ message: "Access denied: You can only delete deals assigned to you" });

      if (deal.assignedTo) await deleteNotificationsByEntity("deal", id, deal.assignedTo._id, tDB);
      await Notification.deleteMany({ "meta.dealId": id });
      await Deal.findByIdAndDelete(id);
      res.status(200).json({ message: "Deal and related notifications deleted successfully" });
    } catch (error) { console.error("Delete deal error:", error); res.status(500).json({ message: "Server error", error: error.message }); }
  },

  bulkDeleteDeals: async (req, res) => {
    try {
      const { Deal, Notification } = getModels(req);
      const tDB = req.tenantDB || null;
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: "No deal IDs provided" });

      const roleName = req.user.role.name?.toLowerCase();
      let query = { _id: { $in: ids } };
      if (roleName === "sales") query.assignedTo = req.user._id;

      const deals = await Deal.find(query).populate("assignedTo");
      for (const deal of deals) {
        if (deal.assignedTo) await deleteNotificationsByEntity("deal", deal._id, deal.assignedTo._id, tDB);
        await Notification.deleteMany({ "meta.dealId": deal._id });
      }
      const result = await Deal.deleteMany(query);
      res.status(200).json({ message: `${result.deletedCount} deal(s) and their notifications deleted successfully`, deletedCount: result.deletedCount });
    } catch (error) { console.error("Bulk delete error:", error); res.status(500).json({ message: "Server error", error: error.message }); }
  },

  // Admin: reject a deal with a reason instead of deleting it — the deal moves
  // to the dedicated Reject Deals page, stage flips to Rejected, and it
  // disappears from the sales person's own account entirely.
  rejectDeal: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied: Admins only" });
      }
      const { Deal } = getModels(req);
      const { reason } = req.body;
      if (!reason?.trim()) return res.status(400).json({ message: "Rejection reason is required" });

      const deal = await Deal.findById(req.params.id).populate("assignedTo");
      if (!deal) return res.status(404).json({ message: "Deal not found" });

      const previousStage = deal.stage;
      deal.stage = "Rejected";
      deal.rejectionReason = reason.trim();
      deal.rejectedBy = req.user._id;
      deal.rejectedAt = new Date();
      if (!deal.stageHistory) deal.stageHistory = [];
      deal.stageHistory.push({ stage: "Rejected", movedAt: new Date(), movedBy: req.user._id });
      if (previousStage === "Closed Won") { deal.wonAt = null; deal.wonBy = null; }
      await deal.save();

      if (deal.assignedTo) {
        const adminName = `${req.user.firstName || ""} ${req.user.lastName || ""}`.trim() || "Admin";
        const spId = String(deal.assignedTo._id || deal.assignedTo);
        notifyUser(spId, "deal_rejected", { dealId: deal._id, dealName: deal.dealName, reason: reason.trim() });
        await sendNotification(spId, `Deal "${deal.dealName}" was rejected by ${adminName}. Reason: ${reason.trim()}`, "deal",
          { dealId: deal._id, dealName: deal.dealName }, { title: "Deal Rejected" }, req.tenantDB || null);
      }

      res.status(200).json({ message: "Deal rejected", deal });
    } catch (error) {
      console.error("Error rejecting deal:", error);
      res.status(500).json({ message: error.message });
    }
  },

  // Admin: dedicated list of rejected deals, with reason/who/when — search,
  // filter, and paginate independently of the main Deals list.
  getRejectedDeals: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied: Admins only" });
      }
      const { Deal, User } = getModels(req);
      const { search = "", clientType, assignee, startDate, endDate, page = 1, limit = 10 } = req.query;
      const query = { stage: "Rejected" };

      if (search?.trim()) {
        query.$or = [
          { dealName:        { $regex: search, $options: "i" } },
          { email:           { $regex: search, $options: "i" } },
          { phoneNumber:     { $regex: search, $options: "i" } },
          { companyName:     { $regex: search, $options: "i" } },
          { rejectionReason: { $regex: search, $options: "i" } },
        ];
      }
      if (clientType && clientType !== "") query.clientType = clientType;

      if (assignee && assignee !== "") {
        if (/^[0-9a-fA-F]{24}$/.test(assignee)) {
          query.assignedTo = assignee;
        } else {
          const nameParts = assignee.split(" ");
          const firstName = nameParts[0];
          const lastName  = nameParts.slice(1).join(" ");
          const userQuery = lastName
            ? { firstName: { $regex: firstName, $options: "i" }, lastName: { $regex: lastName, $options: "i" } }
            : { $or: [{ firstName: { $regex: firstName, $options: "i" } }, { lastName: { $regex: firstName, $options: "i" } }] };
          const users   = await User.find(userQuery).select("_id");
          const userIds = users.map((u) => u._id);
          if (!userIds.length)
            return res.status(200).json({ deals: [], totalDeals: 0, totalPages: 0, currentPage: Number(page) });
          query.assignedTo = { $in: userIds };
        }
      }

      if (startDate || endDate) {
        query.rejectedAt = {};
        if (startDate) query.rejectedAt.$gte = new Date(startDate);
        if (endDate) query.rejectedAt.$lte = new Date(`${endDate}T23:59:59.999Z`);
      }

      const skip       = (page - 1) * limit;
      const totalDeals = await Deal.countDocuments(query);
      const deals      = await Deal.find(query)
        .populate("assignedTo", "firstName lastName email")
        .populate("rejectedBy", "firstName lastName")
        .sort({ rejectedAt: -1 })
        .skip(skip)
        .limit(Number(limit));

      res.status(200).json({ deals, totalDeals, totalPages: Math.ceil(totalDeals / limit), currentPage: Number(page) });
    } catch (error) {
      console.error("Get rejected deals error:", error);
      res.status(500).json({ message: error.message });
    }
  },

  // Admin: permanently delete multiple rejected deals at once
  bulkDeleteRejectedDeals: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied: Admins only" });
      }
      const { Deal, Notification } = getModels(req);
      const { ids } = req.body;
      if (!Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ message: "ids array is required" });
      }

      const rejectedIds = await Deal.find({ _id: { $in: ids }, stage: "Rejected" }).distinct("_id");
      await Notification.deleteMany({ "meta.dealId": { $in: rejectedIds.map(String) } });
      await Deal.deleteMany({ _id: { $in: rejectedIds } });

      res.status(200).json({ message: "Rejected deals deleted", deletedCount: rejectedIds.length });
    } catch (error) {
      console.error("Bulk delete rejected deals error:", error);
      res.status(500).json({ message: error.message });
    }
  },

  pendingDeals: async (req, res) => {
    try {
      const { Deal } = getModels(req);
      let query = { stage: { $nin: ["Closed Won", "Closed Lost"] } };
      if (req.user.role.name !== "Admin") query.assignedTo = req.user._id;
      const deals = await Deal.find(query).populate("assignedTo", "firstName lastName email").sort({ createdAt: -1 }).limit(10);
      res.status(200).json(deals);
    } catch (error) { console.error("Pending deals error:", error); res.status(500).json({ message: "Server error" }); }
  },

  updateDealFollowUp: async (req, res) => {
    try {
      const { Deal } = getModels(req);
      const tDB = req.tenantDB || null;
      const { id } = req.params;
      const { followUpDate, followUpComment } = req.body;
      const deal = await Deal.findById(id).populate("assignedTo");
      if (!deal) return res.status(404).json({ message: "Deal not found" });
      if (req.user.role.name !== "Admin" && deal.assignedTo?._id.toString() !== req.user._id.toString())
        return res.status(403).json({ message: "Access denied" });

      const oldDate = deal.followUpDate;
      const newDate = followUpDate ? new Date(followUpDate) : null;
      const dateChanged = oldDate?.toDateString() !== newDate?.toDateString();

      deal.followUpDate    = newDate;
      deal.followUpComment = followUpComment || deal.followUpComment;
      deal.lastReminderAt  = null;
      if (dateChanged) deal.followUpHistory = [...(deal.followUpHistory || []),
        { date: new Date(), followUpDate: newDate, followUpComment: followUpComment || "", changedBy: req.user._id, action: oldDate ? "Updated" : "Created" }];
      await deal.save();

      if (dateChanged) {
        const assignedUserId = deal.assignedTo?._id || deal.assignedTo || null;
        if (assignedUserId) {
          await deleteNotificationsByEntity("deal", id, assignedUserId, tDB);
          await sendNotification(assignedUserId, `Deal follow-up scheduled: ${deal.dealName}`, "followup",
            { dealId: deal._id, dealName: deal.dealName, profileImage: deal.assignedTo?.profileImage },
            { title: "Deal Follow-up", followUpDate: deal.followUpDate }, tDB);
        }
        await sendNotificationToAdmins(`Deal follow-up scheduled: ${deal.dealName}`, "followup",
          { dealId: deal._id, dealName: deal.dealName, profileImage: deal.assignedTo?.profileImage },
          { title: "Deal Follow-up", followUpDate: deal.followUpDate },
          assignedUserId ? [assignedUserId] : [], tDB);
      }
      res.status(200).json({ message: "Follow-up updated successfully", deal });
    } catch (error) { console.error("Update follow-up error:", error); res.status(500).json({ message: error.message }); }
  },

  // Full, unpaginated dataset for the Export-to-Excel button — same
  // visibility rules as getAllDeals (own deals only for non-admin, rejected
  // deals always excluded) but ignores any active search/filter state.
  exportDeals: async (req, res) => {
    try {
      const { Deal } = getModels(req);
      const query = {};
      if (req.user.role.name !== "Admin") query.assignedTo = req.user._id;

      const hiddenStages = req.user.role.name !== "Admin" ? ["Rejected", "Closed Won"] : ["Rejected"];
      query.stage = { $nin: hiddenStages };

      // Optional date range filter (by createdAt) — omit either/both to
      // export without that bound; omit both to export everything.
      const { startDate, endDate } = req.query;
      if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = new Date(startDate);
        if (endDate) query.createdAt.$lte = new Date(endDate + "T23:59:59.999Z");
      }

      const deals = await Deal.find(query)
        .populate("assignedTo", "firstName lastName email")
        .sort({ createdAt: -1 })
        .lean();

      const data = deals.map((deal) => ({
        dealName:        deal.dealName || "",
        companyName:     deal.companyName || "",
        phoneNumber:     deal.phoneNumber || "",
        dealTitle:       deal.dealTitle || "",
        assignedTo:      deal.assignedTo?.email || "",
        value:           deal.value || "",
        currency:        deal.currency || "",
        clientType:      deal.clientType || "",
        discountGiven:   deal.discountGiven ?? "",
        stage:           deal.stage || "",
        email:           deal.email || "",
        source:          deal.source || "",
        companySize:     deal.companySize || "",
        industry:        deal.industry || "",
        requirement:     deal.requirement || "",
        address:         deal.address || "",
        country:         deal.country || "",
        notes:           deal.notes || "",
        followUpDate:    deal.followUpDate ? new Date(deal.followUpDate).toISOString().slice(0, 10) : "",
        followUpComment: deal.followUpComment || "",
        createdAt:       deal.createdAt ? new Date(deal.createdAt).toISOString().slice(0, 10) : "",
      }));

      res.status(200).json({ success: true, data });
    } catch (error) {
      console.error("Error exporting deals:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  // Bulk-create deals parsed from an uploaded Excel template. Mirrors
  // createManualDeal's defaults but never fails the whole batch for one bad
  // row — each row succeeds or fails independently and is reported back.
  bulkImportDeals: async (req, res) => {
    try {
      const { Deal, User } = getModels(req);
      const rows = Array.isArray(req.body.deals) ? req.body.deals : [];
      if (!rows.length) {
        return res.status(400).json({ success: false, message: "No deal rows provided" });
      }

      const allowedStages = ["Qualification", "Proposal Sent-Negotiation", "Invoice Sent", "Closed Won", "Closed Lost"];
      const results = { created: 0, failed: 0, errors: [] };

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i] || {};
        const rowNum = i + 2;

        try {
          const dealName    = String(row.dealName || "").trim();
          const companyName = String(row.companyName || "").trim();
          const phoneNumber = String(row.phoneNumber || "").trim();

          if (!dealName || !phoneNumber || !companyName) {
            results.failed++;
            results.errors.push(`Row ${rowNum}: dealName, phoneNumber, and companyName are required`);
            continue;
          }

          let assignedTo = null;
          const assignedToEmail = String(row.assignedTo || "").trim();
          if (assignedToEmail) {
            const matchedUser = await User.findOne({ email: new RegExp(`^${assignedToEmail}$`, "i") });
            assignedTo = matchedUser?._id || null;
          }

          const stage = allowedStages.includes(row.stage) ? row.stage : "Qualification";
          const currency = String(row.currency || "INR").trim() || "INR";
          const formattedValue = row.value && String(row.value).trim() !== "" ? formatDealValue(row.value, currency) : "0";
          const clientType = row.clientType === "B2B" || row.clientType === "B2C" ? row.clientType : undefined;
          const companySize = ["Small", "Medium", "Large", "Enterprise"].includes(row.companySize) ? row.companySize : undefined;
          const followUpDate = row.followUpDate && !isNaN(new Date(row.followUpDate).getTime())
            ? new Date(row.followUpDate)
            : null;

          const deal = new Deal({
            dealName, companyName, phoneNumber,
            dealTitle:  String(row.dealTitle || "").trim(),
            assignedTo,
            value:      formattedValue,
            currency,
            clientType,
            discountGiven: Number(row.discountGiven) || 0,
            stage,
            email:      String(row.email || "").trim(),
            source:     String(row.source || "").trim(),
            companySize,
            industry:   String(row.industry || "").trim(),
            requirement: String(row.requirement || "").trim(),
            address:    String(row.address || "").trim(),
            country:    String(row.country || "").trim(),
            notes:      String(row.notes || "").trim(),
            followUpDate,
            followUpComment: String(row.followUpComment || "").trim(),
            stageHistory: [{ stage, movedAt: new Date(), movedBy: req.user._id }],
          });

          await deal.save();
          results.created++;
        } catch (rowErr) {
          results.failed++;
          results.errors.push(`Row ${rowNum}: ${rowErr.message}`);
        }
      }

      res.status(200).json({ success: true, ...results });
    } catch (error) {
      console.error("Error bulk-importing deals:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  },
};
