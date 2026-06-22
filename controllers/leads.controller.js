// controllers/leads.controller.js
import dayjs from "dayjs";
import sendEmail from "../services/email.js";
import { notifyUser } from "../realtime/socket.js";
import { getTenantModels } from "../models/tenant/index.js";
import {
  deleteNotificationsByEntity,
  deleteAllNotificationsByEntity,
  sendNotification,
  sendNotificationToAdmins,
} from "../services/notificationService.js";

// Legacy fallbacks
import LeadLegacy         from "../models/leads.model.js";
import UserLegacy         from "../models/user.model.js";
import DealLegacy         from "../models/deals.model.js";
import NotificationLegacy from "../models/notification.model.js";

// Resolve models from tenant or legacy connection
const getModels = (req) => {
  if (req.tenantDB) return getTenantModels(req.tenantDB);
  return {
    Lead:         LeadLegacy,
    User:         UserLegacy,
    Deal:         DealLegacy,
    Notification: NotificationLegacy,
  };
};

// Auto-assign to the next sales user (round-robin)
const pickNextSalesUser = async (User, Lead) => {
  const users = await User
    .find({})
    .populate("role", "name")
    .select("_id firstName lastName role createdAt")
    .sort({ createdAt: 1, _id: 1 })
    .lean();

  const salesUsers = users.filter((u) => {
    const roleName =
      typeof u.role === "string"
        ? u.role
        : u.role?.name || u.role?.roleName || "";
    return String(roleName).toLowerCase() === "sales";
  });

  if (!salesUsers.length) return null;

  const lastLead = await Lead.findOne({ assignTo: { $ne: null } })
    .sort({ createdAt: -1, _id: -1 })
    .select("assignTo")
    .lean();

  if (!lastLead?.assignTo) return salesUsers[0]._id;

  const lastIdx = salesUsers.findIndex(
    (u) => u._id.toString() === lastLead.assignTo.toString()
  );
  const nextIdx = lastIdx === -1 ? 0 : (lastIdx + 1) % salesUsers.length;
  return salesUsers[nextIdx]._id;
};

export default {
  createLead: async (req, res) => {
    try {
      const { Lead, User } = getModels(req);
      const { leadName, companyName, phoneNumber } = req.body;
      if (!leadName || !companyName || !phoneNumber) {
        return res.status(400).json({
          message: "Lead name, company name, and phone number are required",
        });
      }

      const data = { ...req.body };
      if (!data.clientType || data.clientType === "") {
        delete data.clientType;
      }

      let existingAttachments = [];
      if (req.body.existingAttachments) {
        try { existingAttachments = JSON.parse(req.body.existingAttachments); } catch {}
      }

      let newAttachments = [];
      if (req.files?.length > 0) {
        newAttachments = req.files.map((file) => ({
          name: file.originalname,
          path: `/uploads/leads/${file.filename}`,
          type: file.mimetype,
          size: file.size,
          uploadedAt: new Date(),
        }));
      }

      if (existingAttachments.length > 0 || newAttachments.length > 0) {
        data.attachments = [...existingAttachments, ...newAttachments];
      }

      if (!data.assignTo || data.assignTo === "") {
        data.assignTo = await pickNextSalesUser(User, Lead);
      }
      if (!data.followUpDate || data.followUpDate === "") data.followUpDate = new Date();
      if (!data.status) data.status = "Cold";
      data.lastReminderAt = null;

      const lead      = new Lead(data);
      const savedLead = await lead.save();
      res.status(201).json({ message: "Lead created successfully", lead: savedLead });
    } catch (error) {
      console.error("Create lead error:", error);
      res.status(400).json({ message: error.message });
    }
  },

  getLeads: async (req, res) => {
    try {
      const { Lead, User } = getModels(req);
      const { search = "", status, source, assignee, page = 1, limit = 10 } = req.query;
      const query = {};

      if (req.user.role.name !== "Admin") query.assignTo = req.user._id;

      if (search?.trim()) {
        query.$or = [
          { leadName:    { $regex: search, $options: "i" } },
          { email:       { $regex: search, $options: "i" } },
          { phoneNumber: { $regex: search, $options: "i" } },
          { companyName: { $regex: search, $options: "i" } },
          { source:      { $regex: search, $options: "i" } },
        ];
      }
      if (status && status !== "") query.status = status;
      if (source && source !== "") query.source = source;
      if (req.query.clientType && req.query.clientType !== "") query.clientType = req.query.clientType;

      if (assignee && assignee !== "") {
        if (/^[0-9a-fA-F]{24}$/.test(assignee)) {
          query.assignTo = assignee;
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
            return res.status(200).json({ leads: [], totalLeads: 0, totalPages: 0, currentPage: Number(page) });
          query.assignTo = { $in: userIds };
        }
      }

      const skip       = (page - 1) * limit;
      const totalLeads = await Lead.countDocuments(query);
      const leads      = await Lead.find(query)
        .populate("assignTo", "firstName lastName email role")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit));

      res.status(200).json({ leads, totalLeads, totalPages: Math.ceil(totalLeads / limit), currentPage: Number(page) });
    } catch (error) {
      console.error("Get leads error:", error);
      res.status(500).json({ message: error.message });
    }
  },

  getLeadById: async (req, res) => {
    try {
      const { Lead } = getModels(req);
      const lead = await Lead.findById(req.params.id).populate("assignTo", "firstName lastName email role");
      if (!lead) return res.status(404).json({ message: "Lead not found" });
      res.status(200).json(lead);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  },

  updateLead: async (req, res) => {
    try {
      const { Lead } = getModels(req);
      const tDB     = req.tenantDB || null;
      const before  = await Lead.findById(req.params.id).populate("assignTo");
      if (!before) return res.status(404).json({ message: "Lead not found" });

      const patch = { ...req.body };

      // Sanitize ObjectId fields — empty string crashes Mongoose cast
      if ("assignTo" in patch && (!patch.assignTo || patch.assignTo === "")) {
        patch.assignTo = null;
      }
      if ("companyId" in patch && (!patch.companyId || patch.companyId === "")) {
        patch.companyId = null;
      }
      if ("clientType" in patch && (!patch.clientType || patch.clientType === "")) {
        patch.clientType = null;
      }

      let existingAttachments = [];
      if (req.body.existingAttachments) {
        try { existingAttachments = JSON.parse(req.body.existingAttachments); } catch {}
      }
      let newFiles = [];
      if (req.files?.length > 0) {
        newFiles = req.files.map((file) => ({
          name: file.originalname, path: `/uploads/leads/${file.filename}`,
          type: file.mimetype, size: file.size, uploadedAt: new Date(),
        }));
      }
      patch.attachments = [...existingAttachments, ...newFiles];

      const oldFollowUpDate = before.followUpDate;
      const newFollowUpDate = patch.followUpDate ? new Date(patch.followUpDate) : null;
      const followUpChanged = !oldFollowUpDate || !newFollowUpDate ||
        oldFollowUpDate.toISOString() !== newFollowUpDate.toISOString();

      if (patch.status && patch.status !== before.status) patch.lastReminderAt = null;
      if (patch.followUpDate) patch.lastReminderAt = null;

      const updated = await Lead.findByIdAndUpdate(req.params.id, patch, { new: true })
        .populate("assignTo", "firstName lastName email profileImage");

      if (followUpChanged) {
        await deleteAllNotificationsByEntity("lead", req.params.id, tDB);
        if (updated.assignTo) {
          await sendNotification(updated.assignTo._id, `Lead follow-up rescheduled: ${updated.leadName}`, "followup",
            { leadId: updated._id, leadName: updated.leadName, profileImage: updated.assignTo?.profileImage },
            { title: "Lead Follow-up", followUpDate: updated.followUpDate }, tDB);
          await sendNotificationToAdmins(`Lead follow-up rescheduled: ${updated.leadName}`, "followup",
            { leadId: updated._id, leadName: updated.leadName, profileImage: updated.assignTo?.profileImage },
            { title: "Lead Follow-up", followUpDate: updated.followUpDate }, [updated.assignTo._id], tDB);
        }
      }

      if (before.status !== "Converted" && updated.status === "Converted") {
        const userId   = updated.assignTo?._id?.toString();
        const fullName = `${updated.assignTo?.firstName || ""} ${updated.assignTo?.lastName || ""}`.trim();
        if (userId) notifyUser(userId, "deal:converted", { leadId: updated._id, leadName: updated.leadName, when: new Date() });
        if (updated.assignTo?.email)
          await sendEmail({ to: updated.assignTo.email, subject: ` Deal Converted: ${updated.leadName}`, text: `Deal converted for lead ${updated.leadName}. Congrats, ${fullName}!` });
      }

      res.status(200).json({ message: "Lead updated successfully", lead: updated });
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  },

  deleteLead: async (req, res) => {
    try {
      const { Lead } = getModels(req);
      const tDB  = req.tenantDB || null;
      const lead = await Lead.findById(req.params.id).populate("assignTo");
      if (!lead) return res.status(404).json({ message: "Lead not found" });

      await deleteAllNotificationsByEntity("lead", req.params.id, tDB);
      await Lead.findByIdAndDelete(req.params.id);
      res.status(200).json({ message: "Lead and related notifications deleted successfully" });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  },

  updateFollowUpDate: async (req, res) => {
    try {
      const { Lead } = getModels(req);
      const tDB  = req.tenantDB || null;
      const { followUpDate } = req.body;
      if (!followUpDate) return res.status(400).json({ message: "followUpDate required" });

      const lead = await Lead.findById(req.params.id).populate("assignTo");
      if (!lead) return res.status(404).json({ message: "Lead not found" });

      const oldDate   = lead.followUpDate;
      const newDate   = new Date(followUpDate);
      const dateChanged = !oldDate || oldDate.toISOString() !== newDate.toISOString();

      lead.followUpDate   = newDate;
      lead.lastReminderAt = null;
      await lead.save();

      if (dateChanged) {
        await deleteAllNotificationsByEntity("lead", req.params.id, tDB);
        if (lead.assignTo) {
          await sendNotification(lead.assignTo._id, `Lead follow-up scheduled: ${lead.leadName}`, "followup",
            { leadId: lead._id, leadName: lead.leadName, profileImage: lead.assignTo?.profileImage },
            { title: "Lead Follow-up", followUpDate: lead.followUpDate }, tDB);
          await sendNotificationToAdmins(`Lead follow-up scheduled: ${lead.leadName}`, "followup",
            { leadId: lead._id, leadName: lead.leadName, profileImage: lead.assignTo?.profileImage },
            { title: "Lead Follow-up", followUpDate: lead.followUpDate }, [lead.assignTo._id], tDB);
        }
      }
      return res.status(200).json({ message: "Follow-up date updated", lead });
    } catch (error) {
      return res.status(400).json({ message: error.message });
    }
  },

  convertLeadToDeal: async (req, res) => {
    try {
      const { Lead, Deal, Notification } = getModels(req);
      const tDB  = req.tenantDB || null;
      const lead = await Lead.findById(req.params.id).populate("assignTo");
      if (!lead) return res.status(404).json({ message: "Lead not found" });
      if (lead.status === "Converted") return res.status(400).json({ message: "Lead already converted" });

      const { value, notes, currency, stage } = req.body;
      const numericValue    = Number(value || 0);
      const formattedNumber = new Intl.NumberFormat("en-IN").format(numericValue);
      const formattedValue  = `${formattedNumber} ${currency || "INR"}`;

      const deal = new Deal({
        leadId:        lead._id,
        dealName:      lead.leadName,
        assignedTo:    lead.assignTo?._id ?? null,
        value:         formattedValue,
        currency:      currency || "INR",
        notes:         notes || "",
        stage:         stage || "Qualification",
        email:         lead.email || "",
        phoneNumber:   lead.phoneNumber || "",
        source:        lead.source || "",
        companyName:   lead.companyName || "",
        industry:      lead.industry || "",
        requirement:   lead.requirement || "",
        country:       lead.country || "",
        address:       lead.address || "",
        ...(lead.clientType && { clientType: lead.clientType }),
        attachments:   lead.attachments || [],
        followUpDate:  lead.followUpDate ?? null,
        lastReminderAt: lead.lastReminderAt ?? null,
        companyId:     lead.companyId || null,
        companySize:   lead.companySize || "Medium",
      });

      await deal.save();

      // Delete all notifications for this lead
      if (lead.assignTo) {
        await deleteNotificationsByEntity("lead", req.params.id, lead.assignTo._id, tDB);
      }
      await Notification.deleteMany({ "meta.leadId": req.params.id });

      // Delete the lead
      await Lead.findByIdAndDelete(req.params.id);

      // Notify the assigned user about the conversion
      const userId = lead.assignTo?._id?.toString();
      if (userId) {
        notifyUser(userId, "deal:created", {
          dealId:   deal._id,
          dealName: deal.dealName,
          leadName: lead.leadName,
        });
      }

      // Send email notification if assignee has email
      if (lead.assignTo?.email) {
        await sendEmail({
          to:      lead.assignTo.email,
          subject: ` Lead Converted: ${lead.leadName}`,
          text:    `Lead "${lead.leadName}" has been successfully converted to a deal. Deal Name: ${deal.dealName}, Value: ${formattedValue}`,
        });
      }

      res.status(200).json({ message: "Lead converted to deal successfully", deal, leadDeleted: true });
    } catch (error) {
      console.error("Error converting lead to deal:", error);
      res.status(500).json({ message: error.message, details: error.errors });
    }
  },

  getRecentLeads: async (req, res) => {
    try {
      const { Lead } = getModels(req);
      const query = req.user.role.name === "Admin" ? {} : { assignTo: req.user._id };
      const leads = await Lead.find(query).sort({ createdAt: -1 }).limit(5)
        .populate("assignTo", "firstName lastName email");
      res.status(200).json(leads);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  },

  getPendingLeads: async (req, res) => {
    try {
      const { Lead } = getModels(req);
      const query = req.user.role.name === "Admin"
        ? { status: { $ne: "Converted" } }
        : { status: { $ne: "Converted" }, assignTo: req.user._id };
      const leads = await Lead.find(query).sort({ createdAt: -1 }).limit(5)
        .populate("assignTo", "firstName lastName email");
      res.status(200).json(leads);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  },

  updateLeadStatus: async (req, res) => {
    try {
      const { Lead } = getModels(req);
      const { status } = req.body;
      if (!status) return res.status(400).json({ message: "Status required" });

      const lead = await Lead.findById(req.params.id).populate("assignTo");
      if (!lead) return res.status(404).json({ message: "Lead not found" });

      const oldStatus = lead.status;
      lead.status = status;
      if (status !== oldStatus) lead.lastReminderAt = null;
      await lead.save();

      if (oldStatus !== "Converted" && status === "Converted") {
        const userId   = lead.assignTo?._id?.toString();
        const fullName = `${lead.assignTo?.firstName || ""} ${lead.assignTo?.lastName || ""}`.trim();
        if (userId) notifyUser(userId, "deal:converted", { leadId: lead._id, leadName: lead.leadName, when: new Date() });
        if (lead.assignTo?.email)
          await sendEmail({ to: lead.assignTo.email, subject: ` Deal Converted: ${lead.leadName}`,
            text: `Deal converted for lead ${lead.leadName}. Congrats, ${fullName}!` });
      }
      res.status(200).json({ message: "Lead status updated successfully", lead });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  },

  updateLeadFollowUp: async (req, res) => {
    try {
      const { Lead, Notification } = getModels(req);
      const tDB  = req.tenantDB || null;
      const { followUpDate, followUpComment } = req.body;
      if (!followUpDate) return res.status(400).json({ message: "followUpDate required" });

      const lead = await Lead.findById(req.params.id).populate("assignTo");
      if (!lead) return res.status(404).json({ message: "Lead not found" });

      const oldDate     = lead.followUpDate;
      const newDate     = new Date(followUpDate);
      const dateChanged = oldDate?.toDateString() !== newDate?.toDateString();

      lead.followUpDate    = newDate;
      lead.followUpComment = followUpComment || lead.followUpComment;
      lead.lastReminderAt  = null;

      if (dateChanged) {
        lead.followUpHistory = [
          ...(lead.followUpHistory || []),
          { date: new Date(), followUpDate: newDate, followUpComment: followUpComment || "",
            changedBy: req.user._id, action: oldDate ? "Updated" : "Created" },
        ];
      }
      await lead.save();

      if (dateChanged) {
        if (lead.assignTo) await deleteNotificationsByEntity("lead", req.params.id, lead.assignTo._id, tDB);
        await Notification.deleteMany({ "meta.leadId": req.params.id, type: "followup" });
        await deleteAllNotificationsByEntity("lead", req.params.id, tDB);

        if (lead.assignTo) {
          await sendNotification(lead.assignTo._id, `Lead follow-up rescheduled: ${lead.leadName}`, "followup",
            { leadId: lead._id, leadName: lead.leadName, profileImage: lead.assignTo?.profileImage, followUpDate: newDate, oldFollowUpDate: oldDate },
            { title: "Lead Follow-up Updated", followUpDate: newDate }, tDB);
          await sendNotificationToAdmins(`Lead follow-up rescheduled: ${lead.leadName}`, "followup",
            { leadId: lead._id, leadName: lead.leadName, profileImage: lead.assignTo?.profileImage,
              assignedTo: lead.assignTo._id, assignedToName: `${lead.assignTo.firstName} ${lead.assignTo.lastName}`,
              followUpDate: newDate, oldFollowUpDate: oldDate },
            { title: "Lead Follow-up Updated", followUpDate: newDate }, [lead.assignTo._id], tDB);
        }
      }
      return res.status(200).json({ message: "Follow-up updated successfully", lead });
    } catch (error) {
      console.error("Error updating follow-up:", error);
      return res.status(400).json({ message: error.message });
    }
  },
};
