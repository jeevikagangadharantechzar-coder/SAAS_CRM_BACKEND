import sendEmail from "../services/email.js";
import { notifyUser } from "../realtime/socket.js";
import clientLTVController from "./clientLTVController.js";
import { getTenantModels } from "../models/tenant/index.js";
import {
  deleteNotificationsByEntity,
  deleteAllNotificationsByEntity,
  sendNotification,
  sendNotificationToAdmins,
} from "../services/notificationService.js";

// Legacy fallbacks
import DealLegacy         from "../models/deals.model.js";
import LeadLegacy         from "../models/leads.model.js";
import NotificationLegacy from "../models/notification.model.js";

const getModels = (req) => {
  if (req.tenantDB) return getTenantModels(req.tenantDB);
  return { Deal: DealLegacy, Lead: LeadLegacy, Notification: NotificationLegacy };
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
      const { Lead, Deal } = getModels(req);
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
      res.status(200).json({ message: "Lead converted to deal", deal });
    } catch (err) { res.status(500).json({ message: err.message }); }
  },

  createManualDeal: async (req, res) => {
    try {
      const { Deal } = getModels(req);
      const tDB = req.tenantDB || null;
      const {
        dealName, assignTo, dealValue, currency, stage, notes, phoneNumber, email,
        source, companyName, companyId, industry, requirement, address, country,
        followUpDate, followUpComment, lossReason, lossNotes, clientType,
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
      let query = {};
      if (req.user.role.name !== "Admin") query.assignedTo = req.user._id;
      const { start, end } = req.query;
      if (start && end) query.createdAt = { $gte: new Date(start), $lte: new Date(end + "T23:59:59.999Z") };

      // Rejected deals always live on the dedicated Reject Deals page instead —
      // never in the main list, for anyone (including Admin). Closed Won deals
      // stay visible here for Admin only (read-only record-keeping copy) —
      // the sales person's own list never shows a copy, same as Converted leads.
      const hiddenStages = req.user.role.name !== "Admin" ? ["Rejected", "Closed Won"] : ["Rejected"];
      query.stage = query.stage && !hiddenStages.includes(query.stage) ? query.stage : { $nin: hiddenStages };

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

      // Notify admins + the assigned sales person so targets refresh live
      try {
        const { User, Role, Notification } = getModels(req);
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
        // If admin moved the stage, send a persistent notification to salesperson
        if (isAdmin && spId && String(req.user._id) !== spId) {
          const adminName = `${req.user.firstName || ""} ${req.user.lastName || ""}`.trim() || "Admin";
          const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
          await Notification.create({
            userId: deal.assignedTo._id || deal.assignedTo,
            createdBy: req.user._id,
            type: "target",
            title: `Deal Stage Updated by Admin ${adminName}`,
            message: `Your assigned deal "${deal.dealName}" was moved to "${stage}" stage by Admin ${adminName}.`,
            text: `Your assigned deal "${deal.dealName}" was moved to "${stage}" stage by Admin ${adminName}.`,
            referenceId: String(deal._id),
            meta: { dealId: deal._id, dealName: deal.dealName, stage, adminName },
            expiresAt,
            read: false,
            isRead: false,
          });
          notifyUser(spId, "new_notification", {
            title: `Deal Stage Updated by Admin ${adminName}`,
            text: `Your assigned deal "${deal.dealName}" was moved to "${stage}" stage by Admin ${adminName}.`,
            type: "target",
          });
        }
      } catch (_) {}

      res.status(200).json(deal);
    } catch (err) { res.status(500).json({ message: err.message }); }
  },

  updateDeal: async (req, res) => {
    try {
      const { Deal, Notification } = getModels(req);
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

      // Notify admins + assigned sales person so targets refresh live
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

          // If admin moved the stage, send a persistent notification to the salesperson
          const spId = updatedDeal.assignedTo ? String(updatedDeal.assignedTo._id || updatedDeal.assignedTo) : null;
          const isAdmin = req.user.role.name === "Admin";
          if (isAdmin && spId && String(req.user._id) !== spId) {
            const adminName = `${req.user.firstName || ""} ${req.user.lastName || ""}`.trim() || "Admin";
            const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
            await Notification.create({
              userId: updatedDeal.assignedTo._id || updatedDeal.assignedTo,
              createdBy: req.user._id,
              type: "target",
              title: `Deal Stage Updated by Admin ${adminName}`,
              message: `Your assigned deal "${updatedDeal.dealName}" was moved to "${stage}" stage by Admin ${adminName}.`,
              text: `Your assigned deal "${updatedDeal.dealName}" was moved to "${stage}" stage by Admin ${adminName}.`,
              referenceId: String(updatedDeal._id),
              meta: { dealId: updatedDeal._id, dealName: updatedDeal.dealName, stage, adminName },
              expiresAt,
              read: false,
              isRead: false,
            });
            notifyUser(spId, "new_notification", {
              title: `Deal Stage Updated by Admin ${adminName}`,
              text: `Your assigned deal "${updatedDeal.dealName}" was moved to "${stage}" stage by Admin ${adminName}.`,
              type: "target",
            });
          }
        } catch (_) {}
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
      const { followUpDate, followUpComment } = req.body;
      const deal = await Deal.findById(id).populate("assignedTo");
      if (!deal) return res.status(404).json({ message: "Deal not found" });

      const assignedToId = deal.assignedTo?._id?.toString() || deal.assignedTo?.toString();
      if (req.user.role.name !== "Admin" && assignedToId !== req.user._id.toString())
        return res.status(403).json({ message: "Access denied" });
      if (!followUpDate) return res.status(400).json({ message: "Follow-up date is required" });

      const parsedDate = new Date(followUpDate);
      if (isNaN(parsedDate.getTime())) return res.status(400).json({ message: "Invalid date format" });

      const updatedDeal = await Deal.findByIdAndUpdate(id, {
        followUpDate: parsedDate, followUpComment: followUpComment || "",
        lastReminderAt: null,
        followUpHistory: [...(deal.followUpHistory || []),
          { date: new Date(), followUpDate: parsedDate, followUpComment: followUpComment || "",
            changedBy: req.user._id, action: "Scheduled" }],
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
};
