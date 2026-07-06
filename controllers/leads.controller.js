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
import { notifyLeadOrDealEdited, notifyLeadStatusChangedByAdmin, notifyLeadConvertedByAdmin } from "../services/taskNotificationService.js";

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
      const { Lead, User, Notification } = getModels(req);
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

      if (data.assignTo && req.user?.role?.name === "Admin" && String(data.assignTo) !== String(req.user._id)) {
        const adminName = `${req.user.firstName || ""} ${req.user.lastName || ""}`.trim() || "Admin";
        Notification.create({
          userId: data.assignTo,
          createdBy: req.user._id,
          type: "task",
          title: `New Lead Assigned by Admin ${adminName}`,
          message: `Admin ${adminName} assigned you a new lead: "${savedLead.leadName}"`,
          text: `Admin ${adminName} assigned you a new lead: "${savedLead.leadName}"`,
          referenceId: String(savedLead._id),
          meta: { leadAssigned: true, leadId: String(savedLead._id), leadName: savedLead.leadName, adminName },
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          read: false,
          isRead: false,
        }).catch((err) => console.error("New lead assigned notification error:", err));
      }

      res.status(201).json({ message: "Lead created successfully", lead: savedLead });

      // Notify all active admins so dashboard counts update live
      try {
        const { Role } = getModels(req);
        const payload = { leadId: String(savedLead._id), leadName: savedLead.leadName };
        if (Role) {
          const adminRole = await Role.findOne({ name: "Admin" });
          if (adminRole) {
            const admins = await User.find({ role: adminRole._id, status: "Active" }).select("_id");
            admins.forEach(a => notifyUser(String(a._id), "lead_created", payload));
          }
        }
      } catch (_) {}
    } catch (error) {
      console.error("Create lead error:", error);
      res.status(400).json({ message: error.message });
    }
  },

  getLeads: async (req, res) => {
    try {
      const { Lead, User } = getModels(req);
      const { search = "", status, source, assignee, page = 1, limit = 10, followUpStatus } = req.query;
      const query = {};
      const andConditions = [];

      if (req.user.role.name !== "Admin") query.assignTo = req.user._id;

      if (search?.trim()) {
        andConditions.push({
          $or: [
            { leadName:    { $regex: search, $options: "i" } },
            { email:       { $regex: search, $options: "i" } },
            { phoneNumber: { $regex: search, $options: "i" } },
            { companyName: { $regex: search, $options: "i" } },
            { source:      { $regex: search, $options: "i" } },
          ],
        });
      }
      if (status && status !== "") query.status = status;
      if (source && source !== "") query.source = source;
      if (req.query.clientType && req.query.clientType !== "") query.clientType = req.query.clientType;

      if (followUpStatus === "missed") {
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        query.followUpDate = { $lt: startOfToday };
        if (!query.status) query.status = { $nin: ["Converted", "Junk"] };
        andConditions.push({ $or: [{ followUpNotes: { $exists: false } }, { followUpNotes: { $size: 0 } }] });
      } else if (followUpStatus === "completed") {
        andConditions.push({ "followUpNotes.0": { $exists: true } });
      }

      if (andConditions.length) query.$and = andConditions;

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

      // Rejected leads always live on the dedicated Rejected Leads page instead
      // — never in the main list, for anyone (including Admin). Converted
      // leads stay visible here for Admin only (read-only record-keeping copy).
      const hiddenStatuses = req.user.role.name !== "Admin" ? ["Rejected", "Converted"] : ["Rejected"];
      query.status = query.status && !hiddenStatuses.includes(query.status) ? query.status : { $nin: hiddenStatuses };

      const skip       = (page - 1) * limit;
      const totalLeads = await Lead.countDocuments(query);
      const leads      = await Lead.find(query)
        .populate("assignTo", "firstName lastName email role")
        .populate("rejectedBy", "firstName lastName")
        .populate({ path: "convertedBy", select: "firstName lastName role", populate: { path: "role", select: "name" } })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit));

      res.status(200).json({ leads, totalLeads, totalPages: Math.ceil(totalLeads / limit), currentPage: Number(page) });
    } catch (error) {
      console.error("Get leads error:", error);
      res.status(500).json({ message: error.message });
    }
  },

  // Admin: dedicated list of rejected leads, with reason/who/when — search,
  // filter, and paginate independently of the main Leads list.
  getRejectedLeads: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied: Admins only" });
      }
      const { Lead, User } = getModels(req);
      const { search = "", source, clientType, assignee, startDate, endDate, page = 1, limit = 10 } = req.query;
      const query = { status: "Rejected" };

      if (search?.trim()) {
        query.$or = [
          { leadName:        { $regex: search, $options: "i" } },
          { email:           { $regex: search, $options: "i" } },
          { phoneNumber:     { $regex: search, $options: "i" } },
          { companyName:     { $regex: search, $options: "i" } },
          { rejectionReason: { $regex: search, $options: "i" } },
        ];
      }
      if (source && source !== "") query.source = source;
      if (clientType && clientType !== "") query.clientType = clientType;

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

      if (startDate || endDate) {
        query.rejectedAt = {};
        if (startDate) query.rejectedAt.$gte = new Date(startDate);
        if (endDate) query.rejectedAt.$lte = new Date(`${endDate}T23:59:59.999Z`);
      }

      const skip        = (page - 1) * limit;
      const totalLeads  = await Lead.countDocuments(query);
      const leads       = await Lead.find(query)
        .populate("assignTo", "firstName lastName email")
        .populate("rejectedBy", "firstName lastName")
        .sort({ rejectedAt: -1 })
        .skip(skip)
        .limit(Number(limit));

      res.status(200).json({ leads, totalLeads, totalPages: Math.ceil(totalLeads / limit), currentPage: Number(page) });
    } catch (error) {
      console.error("Get rejected leads error:", error);
      res.status(500).json({ message: error.message });
    }
  },

  // Admin: permanently delete multiple rejected leads at once
  bulkDeleteRejectedLeads: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied: Admins only" });
      }
      const { Lead, Notification } = getModels(req);
      const { ids } = req.body;
      if (!Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ message: "ids array is required" });
      }

      const rejectedIds = await Lead.find({ _id: { $in: ids }, status: "Rejected" }).distinct("_id");
      await Notification.deleteMany({ "meta.leadId": { $in: rejectedIds.map(String) } });
      await Lead.deleteMany({ _id: { $in: rejectedIds } });

      res.status(200).json({ message: "Rejected leads deleted", deletedCount: rejectedIds.length });
    } catch (error) {
      console.error("Bulk delete rejected leads error:", error);
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

      const isAdminLead = req.user.role?.name === "Admin";
      if (patch.status && patch.status !== before.status) {
        patch.lastReminderAt = null;
        // Always record status moves for full journey tracking (admin + salesperson)
        patch.$push = { statusHistory: { status: patch.status, changedAt: new Date() } };
      }
      if (patch.followUpDate) patch.lastReminderAt = null;

      const { $push, ...patchWithoutPush } = patch;
      const updateOp = $push ? { ...patchWithoutPush, $push } : patchWithoutPush;
      const updated = await Lead.findByIdAndUpdate(req.params.id, updateOp, { new: true })
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

      // If admin changed the status, send a single persistent notification to
      // the salesperson (type "task", meta.leadStatusChanged — replaces the
      // old duplicate "target"-typed block that showed the same event twice,
      // once in My Task and once in My Target).
      if (patch.status && patch.status !== before.status && isAdminLead) {
        notifyLeadStatusChangedByAdmin(getModels(req), { lead: updated, status: updated.status, previousStatus: before.status, actorId: req.user._id })
          .catch((err) => console.error("notifyLeadStatusChangedByAdmin error:", err));
      }

      // Admin edited general details (not just status/follow-up) — notify the assignee
      if (isAdminLead) {
        const coreEditPairs = [
          [patch.leadName, before.leadName], [patch.phoneNumber, before.phoneNumber], [patch.email, before.email],
          [patch.companyName, before.companyName], [patch.source, before.source], [patch.requirement, before.requirement],
        ];
        const hasCoreEdit = coreEditPairs.some(([next, prev]) => next !== undefined && String(next) !== String(prev || ""));
        if (hasCoreEdit) {
          const adminName = `${req.user.firstName || ""} ${req.user.lastName || ""}`.trim() || "Admin";
          notifyLeadOrDealEdited(getModels(req), { itemType: "lead", item: updated, actorId: req.user._id, adminName })
            .catch((err) => console.error("notifyLeadOrDealEdited error:", err));
        }
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
      if (lead.status === "Rejected" || lead.status === "Converted") {
        return res.status(403).json({ message: `This lead is ${lead.status.toLowerCase()} and can no longer be edited.` });
      }
      if (lead.isActive === false && req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "This lead is disabled pending admin reassignment." });
      }

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
      const { Lead, Deal, Notification, User, Role } = getModels(req);
      const tDB  = req.tenantDB || null;
      const lead = await Lead.findById(req.params.id).populate("assignTo");
      if (!lead) return res.status(404).json({ message: "Lead not found" });
      if (lead.status === "Converted") return res.status(400).json({ message: "Lead already converted" });
      // Capture full status history before deletion
      const leadStatusHistory = lead.statusHistory || [];

      const { value, notes, currency, stage } = req.body;
      const numericValue    = Number(value || 0);
      const formattedNumber = new Intl.NumberFormat("en-IN").format(numericValue);
      const formattedValue  = `${formattedNumber} ${currency || "INR"}`;

      const deal = new Deal({
        leadId:           lead._id,
        dealName:         lead.leadName,
        assignedTo:       lead.assignTo?._id ?? null,
        convertedBy:      req.user._id,
        value:            formattedValue,
        currency:         currency || "INR",
        notes:            notes || "",
        stage:            stage || "Qualification",
        email:            lead.email || "",
        phoneNumber:      lead.phoneNumber || "",
        source:           lead.source || "",
        companyName:      lead.companyName || "",
        industry:         lead.industry || "",
        requirement:      lead.requirement || "",
        country:          lead.country || "",
        address:          lead.address || "",
        ...(lead.clientType && { clientType: lead.clientType }),
        attachments:      lead.attachments || [],
        followUpDate:     lead.followUpDate ?? null,
        lastReminderAt:   lead.lastReminderAt ?? null,
        companyId:        lead.companyId || null,
        companySize:      lead.companySize || "Medium",
        leadStatusHistory: leadStatusHistory,
        leadCreatedAt:    lead.createdAt,
      });

      await deal.save();

      // The lead always keeps a read-only "Converted" copy — regardless of who
      // performed the conversion — for Admin's record-keeping. It's never deleted.
      // getLeads() hides Rejected/Converted leads from the sales person's own
      // account, so the sales person never sees a copy of their own conversions
      // either, while Admin always sees who converted what.
      const isAdmin = req.user.role?.name === "Admin";
      lead.status = "Converted";
      lead.convertedBy = req.user._id;
      lead.statusHistory = [...(lead.statusHistory || []), { status: "Converted", changedAt: new Date() }];
      await lead.save();

      // The conversion itself (deal + lead) is done — respond right away instead
      // of making the user wait on notification cleanup, admin lookups, socket
      // pushes, and an outbound email, none of which affect what they see next.
      res.status(200).json({ message: "Lead converted to deal successfully", deal, leadDeleted: false });

      (async () => {
        try {
          // Clean up any stale notifications tied to the lead's pre-conversion
          // state (e.g. follow-up reminders) — no longer relevant once converted.
          if (lead.assignTo) {
            await deleteNotificationsByEntity("lead", req.params.id, lead.assignTo._id, tDB);
          }
          await Notification.deleteMany({ "meta.leadId": req.params.id });

          const userId = lead.assignTo?._id?.toString();
          const convPayload = { dealId: deal._id, dealName: deal.dealName, leadName: lead.leadName, leadId: lead._id };
          if (userId) {
            notifyUser(userId, "deal:created", convPayload);
            notifyUser(userId, "lead_converted", convPayload);
          }
          // If admin performed the conversion, send a single persistent
          // notification to the salesperson (type "task", meta.leadConverted —
          // this is the actual conversion endpoint the frontend calls, so this
          // replaces the old duplicate "target"-typed block that used to fire
          // from here instead of from the — unused — createDealFromLead path).
          if (isAdmin && userId && String(req.user._id) !== userId) {
            notifyLeadConvertedByAdmin(getModels(req), { lead, deal, actorId: req.user._id })
              .catch((err) => console.error("notifyLeadConvertedByAdmin error:", err));
          }
          // Also notify all admins so Target Management live-updates
          const adminRole = await Role.findOne({ name: "Admin" });
          if (adminRole) {
            const admins = await User.find({ role: adminRole._id, status: "Active" }).select("_id");
            admins.forEach(a => notifyUser(String(a._id), "lead_converted", convPayload));
          }

          // Send email notification if assignee has email
          if (lead.assignTo?.email) {
            await sendEmail({
              to:      lead.assignTo.email,
              subject: ` Lead Converted: ${lead.leadName}`,
              text:    `Lead "${lead.leadName}" has been successfully converted to a deal. Deal Name: ${deal.dealName}, Value: ${formattedValue}`,
            });
          }
        } catch (bgErr) {
          console.error("convertLeadToDeal background tasks error:", bgErr);
        }
      })();
    } catch (error) {
      console.error("Error converting lead to deal:", error);
      res.status(500).json({ message: error.message, details: error.errors });
    }
  },

  getMissedFollowUps: async (req, res) => {
    try {
      const { Lead } = getModels(req);
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const query = {
        followUpDate: { $lt: startOfToday },
        status: { $nin: ["Converted", "Junk"] },
        $or: [{ followUpNotes: { $exists: false } }, { followUpNotes: { $size: 0 } }],
      };
      if (req.user.role.name !== "Admin") query.assignTo = req.user._id;

      const leads = await Lead.find(query)
        .select("leadName companyName followUpDate assignTo")
        .populate("assignTo", "firstName lastName")
        .sort({ followUpDate: 1 });

      res.status(200).json({ leads });
    } catch (error) {
      res.status(500).json({ message: error.message });
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

  addFollowUpNote: async (req, res) => {
    try {
      const { Lead } = getModels(req);
      const tDB  = req.tenantDB || null;
      const { note } = req.body;
      if (!note || !note.trim()) return res.status(400).json({ message: "Note is required" });

      const lead = await Lead.findById(req.params.id);
      if (!lead) return res.status(404).json({ message: "Lead not found" });

      lead.followUpNotes.push({ note: note.trim(), createdAt: new Date() });
      await lead.save();

      // A logged follow-up note means this lead is no longer "missed" —
      // clear any pending missed-follow-up notifications for it.
      await deleteAllNotificationsByEntity("lead", req.params.id, tDB);

      const updated = await Lead.findById(req.params.id).populate("assignTo", "firstName lastName email role");
      res.status(200).json({ message: "Follow-up note added", lead: updated });
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  },

  // Admin: reject a lead with a reason instead of deleting it — the lead stays
  // in the list, status flips to Rejected, and it shows disabled/blurred to everyone.
  rejectLead: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied: Admins only" });
      }
      const { Lead } = getModels(req);
      const { reason } = req.body;
      if (!reason?.trim()) return res.status(400).json({ message: "Rejection reason is required" });

      const lead = await Lead.findById(req.params.id).populate("assignTo");
      if (!lead) return res.status(404).json({ message: "Lead not found" });

      lead.status = "Rejected";
      lead.rejectionReason = reason.trim();
      lead.rejectedBy = req.user._id;
      lead.rejectedAt = new Date();
      lead.statusHistory = [...(lead.statusHistory || []), { status: "Rejected", changedAt: new Date() }];
      await lead.save();

      if (lead.assignTo) {
        const adminName = `${req.user.firstName || ""} ${req.user.lastName || ""}`.trim() || "Admin";
        notifyUser(String(lead.assignTo._id), "lead_rejected", { leadId: lead._id, leadName: lead.leadName, reason: reason.trim() });
        await sendNotification(lead.assignTo._id, `Lead "${lead.leadName}" was rejected by ${adminName}. Reason: ${reason.trim()}`, "lead",
          { leadId: lead._id, leadName: lead.leadName }, { title: "Lead Rejected" }, req.tenantDB || null);
      }

      res.status(200).json({ message: "Lead rejected", lead });
    } catch (error) {
      console.error("Error rejecting lead:", error);
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
