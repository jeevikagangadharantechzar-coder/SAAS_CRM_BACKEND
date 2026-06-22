import { getTenantModels } from "../models/tenant/index.js";
import NotificationLegacy from "../models/notification.model.js";
import UserLegacy         from "../models/user.model.js";
import LeadLegacy         from "../models/leads.model.js";
import DealLegacy         from "../models/deals.model.js";
import ProposalLegacy     from "../models/proposal.model.js";

const getModels = (req) =>
  req.tenantDB
    ? getTenantModels(req.tenantDB)
    : { Notification: NotificationLegacy, User: UserLegacy, Lead: LeadLegacy, Deal: DealLegacy, Proposal: ProposalLegacy };

export default {
  createNotification: async (req, res) => {
    try {
      const { Notification } = getModels(req);
      const { userId, title, message, type, relatedId, relatedModel, scheduledFor, read } = req.body;
      const defaultTitle = title || (
        type === "followup" ? (relatedModel === "Deal" ? "Deal Follow-up" : relatedModel === "Proposal" ? "Proposal Follow-up" : relatedModel === "Lead" ? "Lead Follow-up" : "Follow-up")
        : type === "contact_form" ? "Website Contact Form" : "Notification"
      );
      const textValue    = message || defaultTitle;
      const followUpDate = req.body.followUpDate ? new Date(req.body.followUpDate) : null;

      const notification = await Notification.create({
        userId, title: defaultTitle, message: textValue, text: textValue, type,
        referenceId: relatedId ? String(relatedId) : null, followUpDate,
        meta: {
          dealId:     relatedModel === "Deal"     ? relatedId : undefined,
          leadId:     relatedModel === "Lead"     ? relatedId : undefined,
          proposalId: relatedModel === "Proposal" ? relatedId : undefined,
        },
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        read: read || false,
      });
      res.status(201).json(notification);
    } catch (err) {
      console.error("Create notification error:", err);
      res.status(500).json({ message: err.message });
    }
  },

  getUserNotifications: async (req, res) => {
    try {
      const { Notification, Lead, Deal, Proposal } = getModels(req);
      const { userId } = req.params;
      const now = new Date();

      await Notification.deleteMany({ userId, expiresAt: { $lt: now } });

      let notifications = await Notification.find({
        userId,
        $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gte: now } }],
      }).sort({ createdAt: -1 }).limit(50).lean();

      for (let notif of notifications) {
        if (notif.type === "followup" && notif.meta?.leadId) {
          const lead = await Lead.findById(notif.meta.leadId).populate("assignTo", "profileImage firstName lastName");
          if (lead?.assignTo) {
            notif.profileImage = lead.assignTo.profileImage?.replace(/\\/g, "/") || null;
            notif.userName = `${lead.assignTo.firstName} ${lead.assignTo.lastName}`;
          }
        } else if (notif.type === "followup" && notif.meta?.dealId) {
          const deal = await Deal.findById(notif.meta.dealId).populate("assignedTo", "profileImage firstName lastName");
          if (deal?.assignedTo) {
            notif.profileImage = deal.assignedTo.profileImage?.replace(/\\/g, "/") || null;
            notif.userName = `${deal.assignedTo.firstName} ${deal.assignedTo.lastName}`;
          }
        } else if (notif.type === "followup" && notif.meta?.proposalId) {
          const proposal = await Proposal.findById(notif.meta.proposalId)
            .populate({ path: "deal", populate: { path: "assignedTo", select: "profileImage firstName lastName" } });
          if (proposal?.deal?.assignedTo) {
            notif.profileImage = proposal.deal.assignedTo.profileImage?.replace(/\\/g, "/") || null;
            notif.userName = `${proposal.deal.assignedTo.firstName} ${proposal.deal.assignedTo.lastName}`;
          }
        }
      }
      res.status(200).json(notifications);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: err.message });
    }
  },

  markAsRead: async (req, res) => {
    try {
      const { Notification } = getModels(req);
      const notif = await Notification.findByIdAndUpdate(req.params.id, { read: true }, { new: true });
      if (!notif) return res.status(404).json({ message: "Notification not found" });
      res.status(200).json({ message: "Notification marked as read", notif });
    } catch (err) { res.status(500).json({ message: err.message }); }
  },

  deleteNotification: async (req, res) => {
    try {
      const { Notification } = getModels(req);
      const notif = await Notification.findByIdAndDelete(req.params.id);
      if (!notif) return res.status(404).json({ message: "Not found" });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ message: err.message }); }
  },

  bulkDeleteNotifications: async (req, res) => {
    try {
      const { ids } = req.body;
      if (!ids || !Array.isArray(ids) || ids.length === 0)
        return res.status(400).json({ message: "No IDs provided" });
      const { Notification } = getModels(req);
      await Notification.deleteMany({ _id: { $in: ids } });
      res.status(200).json({ success: true, deletedCount: ids.length });
    } catch (err) { res.status(500).json({ message: err.message }); }
  },
};
