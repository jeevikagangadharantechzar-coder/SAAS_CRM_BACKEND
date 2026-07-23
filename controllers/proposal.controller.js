import nodemailer from "nodemailer";
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import fs from "fs";
import { getTenantModels } from "../models/tenant/index.js";
import { sendEmailWithAttachments } from "../utils/gmailService.js";
import {
  deleteNotificationsByEntity,
  deleteAllNotificationsByEntity,
  sendNotification,
  sendNotificationToAdmins,
} from "../services/notificationService.js";

// Legacy fallbacks
import ProposalLegacy     from "../models/proposal.model.js";
import NotificationLegacy from "../models/notification.model.js";
import DealLegacy         from "../models/deals.model.js";
import SettingsLegacy     from "../models/Settings.js";

dotenv.config();

const getModels = (req) =>
  req.tenantDB
    ? getTenantModels(req.tenantDB)
    : { Proposal: ProposalLegacy, Notification: NotificationLegacy, Deal: DealLegacy };

const getSettings = (req) =>
  req.tenantDB ? getTenantModels(req.tenantDB).Settings : SettingsLegacy;

export default {
  sendProposal: async (req, res) => {
    const { emails, title, dealTitle, selectedDealId, content, image, id, cc, isDraft } = req.body;
    if (!title || !dealTitle) return res.status(400).json({ error: "Title and dealTitle are required" });

    try {
      const { Proposal, Deal } = getModels(req);
      const tDB = req.tenantDB || null;
      const recipients = emails ? emails.split(",").map(e => e.trim()).filter(Boolean) : [];

      let dealInfo = null;
      if (selectedDealId) {
        dealInfo = await Deal.findById(selectedDealId).lean();
        if (!dealInfo) return res.status(404).json({ error: "Deal not found" });
        // Only block on creation — an existing proposal shouldn't fail to save
        // just because its linked deal moved to Closed Won after the fact.
        if (!id && dealInfo.stage === "Closed Won") {
          return res.status(400).json({ error: "Cannot create a proposal for a deal that is already Closed Won." });
        }
      }

      const attachments = (req.files || []).map(file => ({ name: file.originalname, path: file.path, type: file.mimetype, size: file.size, uploadedAt: new Date() }));
      const isDraftMode = isDraft === true || isDraft === "true";
      const status = isDraftMode ? "draft" : "sent";

      const proposalData = {
        title, deal: selectedDealId || null, dealTitle, email: recipients.join(","), cc: cc || "",
        content: content || "", image: image || "", status, attachments,
        companyName: dealInfo?.companyName || "", value: dealInfo?.value || 0,
        followUpDate: status === "draft" ? null : new Date(), lastReminderAt: null,
        lastUpdatedBy: req.user._id,
      };

      const statusHistoryEntry = { status, changedAt: new Date(), changedBy: req.user._id };

      let proposal;
      if (id) {
        const existing = await Proposal.findById(id).select("status");
        const statusChanged = !existing || existing.status !== status;
        proposal = await Proposal.findByIdAndUpdate(
          id,
          statusChanged ? { ...proposalData, $push: { statusHistory: statusHistoryEntry } } : proposalData,
          { new: true, runValidators: true }
        );
        if (!proposal) return res.status(404).json({ error: "Proposal not found" });
      } else {
        proposal = new Proposal({ ...proposalData, createdBy: req.user._id, statusHistory: [statusHistoryEntry] });
        await proposal.save();
      }

      res.json({ message: status === "draft" ? "Proposal saved as draft successfully!" : "Proposal saved successfully! Email is sending in background.", proposal });

      if (status === "sent" && recipients.length > 0) {
        const Settings = getSettings(req);
        const settings = await Settings.findOne();
        const companyName = settings?.companyName || req.tenant?.name || "CRM Software";

        // Embed logo via CID attachment — base64 data URIs are blocked by Gmail
        let logoBlock = "";
        const emailAttachments = (req.files || []).map(file => ({ filename: file.originalname, path: file.path }));
        const logoRelPath = settings?.invoiceLogo || settings?.logo;
        if (logoRelPath) {
          const logoPath = path.join(process.cwd(), logoRelPath);
          if (fs.existsSync(logoPath)) {
            const logoExt = path.extname(logoPath) || ".png";
            emailAttachments.push({ filename: `logo${logoExt}`, path: logoPath, cid: "proposal-logo", contentDisposition: "inline" });
            logoBlock = `<div style="text-align:center; margin-bottom:25px;"><img src="cid:proposal-logo" alt="${companyName}" style="max-height:80px; width:auto;" /></div>`;
          }
        }

        // withLogo is only usable on the shared-mailbox path below — the tenant
        // Gmail-API path has no inline/cid image support, so it sends without
        // the logo rather than showing a broken image.
        const buildEmailHTML = (withLogo) => `
          <div style="background-color:#f4f6f8; padding:40px 0;">
            <div style="max-width:600px; margin:auto; background:white; padding:30px; border-radius:8px;">
              ${withLogo ? logoBlock : ""}
              <div style="font-size:14px; line-height:1.6; color:#333;">
                ${content}
              </div>
              <hr style="margin:30px 0; border:none; border-top:1px solid #eee;" />
              <div style="text-align:center; font-size:12px; color:#888;">
                © ${new Date().getFullYear()} ${companyName}. All rights reserved.
              </div>
            </div>
          </div>
        `;

        const subject = `Proposal: ${title}`;

        if (settings?.invoiceSenderEmail) {
          // Tenant connected their own Gmail via OAuth — send genuinely as that
          // account, same as invoice emails.
          const ccEmails = cc ? cc.split(",").map(e => e.trim()).filter(Boolean).join(",") : "";
          const gmailAttachments = (req.files || []).map(file => ({
            filename: file.originalname,
            content: fs.readFileSync(file.path).toString("base64"),
            mimetype: file.mimetype,
            size: file.size,
          }));
          await sendEmailWithAttachments(recipients.join(","), subject, buildEmailHTML(false).replace(/\n\s*/g, ""), ccEmails, "", gmailAttachments, [], settings.invoiceSenderEmail);
        } else {
          const transporter = nodemailer.createTransport({ service: "gmail", host: "smtp.gmail.com", port: 587, secure: false, auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
          await transporter.sendMail({ from: `"${companyName}" <${process.env.EMAIL_USER}>`, to: recipients.join(","), cc: cc || undefined, subject, html: buildEmailHTML(true), attachments: emailAttachments });
        }

        if (process.env.OWNER_EMAIL) {
          const ownerTransporter = nodemailer.createTransport({ service: "gmail", host: "smtp.gmail.com", port: 587, secure: false, auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
          await ownerTransporter.sendMail({ from: `"CRM Notification" <${process.env.EMAIL_USER}>`, to: process.env.OWNER_EMAIL, subject: `Proposal Sent: ${title}`, text: `A new proposal has been sent to ${recipients.join(",")}.` });
        }
      }
    } catch (error) {
      console.error("Proposal Error:", error);
      res.status(500).json({ error: error.message });
    }
  },

  updateFollowUp: async (req, res) => {
    const { id } = req.params;
    const { followUpDate, followUpComment } = req.body;
    try {
      const { Proposal } = getModels(req);
      const tDB = req.tenantDB || null;
      const proposal = await Proposal.findById(id).populate({ path: "deal", populate: { path: "assignedTo" } });
      if (!proposal) return res.status(404).json({ error: "Proposal not found" });

      const oldDate = proposal.followUpDate;
      const newDate = followUpDate ? new Date(followUpDate) : null;
      const dateChanged = oldDate?.toDateString() !== newDate?.toDateString();

      const updated = await Proposal.findByIdAndUpdate(id, { followUpDate: newDate, followUpComment, lastReminderAt: null }, { new: true })
        .populate({ path: "deal", populate: { path: "assignedTo" } });

      if (dateChanged) {
        await deleteAllNotificationsByEntity("proposal", id, tDB);
        if (updated.deal?.assignedTo) {
          await sendNotification(updated.deal.assignedTo._id, `Proposal follow-up scheduled: ${updated.title}`, "followup",
            { proposalId: updated._id, proposalTitle: updated.title, dealId: updated.deal?._id, profileImage: updated.deal?.assignedTo?.profileImage },
            { title: "Proposal Follow-up", followUpDate: updated.followUpDate }, tDB);
        }
        await sendNotificationToAdmins(`Proposal follow-up scheduled: ${updated.title}`, "followup",
          { proposalId: updated._id, proposalTitle: updated.title, dealId: updated.deal?._id, profileImage: updated.deal?.assignedTo?.profileImage },
          { title: "Proposal Follow-up", followUpDate: updated.followUpDate },
          updated.deal?.assignedTo?._id ? [updated.deal.assignedTo._id] : [], tDB);
      }
      res.json({ message: "Follow-up updated", proposal: updated });
    } catch (err) {
      console.error("FollowUp Update Error:", err);
      res.status(500).json({ error: err.message });
    }
  },

  getDraftProposals: async (req, res) => {
    try {
      const { Proposal, Deal } = getModels(req);
      const userRole = req.user?.role?.name?.toLowerCase();
      const userId   = req.user?._id;
      let query = { status: "draft" };
      if (userRole !== "admin") {
        const userDeals = await Deal.find({ assignedTo: userId }).select("_id");
        query.deal = { $in: userDeals.map(d => d._id) };
      }
      const drafts = await Proposal.find(query).populate("deal").sort({ createdAt: -1 });
      res.json(drafts);
    } catch (error) {
      console.error("Fetch drafts error:", error);
      res.status(500).json({ error: "Server error" });
    }
  },

  getAllProposals: async (req, res) => {
    try {
      const { Proposal, Deal } = getModels(req);
      const userRole = req.user?.role?.name?.toLowerCase();
      const userId   = req.user?._id;
      let query = {};
      if (userRole !== "admin") {
        const userDeals = await Deal.find({ assignedTo: userId }).select("_id");
        query.deal = { $in: userDeals.map(d => d._id) };
      }
      const proposals = await Proposal.find(query).populate("deal").sort({ createdAt: -1 });
      res.json(proposals);
    } catch (error) {
      console.error("Database Fetch Error:", error);
      res.status(500).json({ error: "Server error" });
    }
  },

  updateStatus: async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    try {
      const { Proposal } = getModels(req);

      // A draft has never actually been emailed — flipping its status
      // straight to "sent" (or any other post-send status) via this
      // endpoint would mark it sent without ever sending it. That transition
      // must go through the real send flow (sendProposal), not this one.
      const existing = await Proposal.findById(id).select("status");
      if (!existing) return res.status(404).json({ error: "Proposal not found" });
      if (existing.status === "draft" && status !== "draft") {
        return res.status(400).json({ error: "This draft hasn't been sent yet — send it first before changing its status." });
      }

      const updated = await Proposal.findByIdAndUpdate(
        id,
        {
          status,
          lastUpdatedBy: req.user._id,
          $push: { statusHistory: { status, changedAt: new Date(), changedBy: req.user._id } },
        },
        { new: true }
      );
      if (!updated) return res.status(404).json({ error: "Proposal not found" });
      res.json({ message: "Status updated", proposal: updated });
    } catch (error) {
      console.error("Status Update Error:", error);
      res.status(500).json({ error: "Failed to update status" });
    }
  },

  updateProposal: async (req, res) => {
    const { id } = req.params;
    const { title, dealTitle, email, content, image, status, followUpDate, followUpComment } = req.body;
    try {
      const { Proposal } = getModels(req);
      const tDB = req.tenantDB || null;
      const original = await Proposal.findById(id).populate({ path: "deal", populate: { path: "assignedTo" } });
      if (!original) return res.status(404).json({ error: "Proposal not found" });

      const oldFollowUpDate = original.followUpDate;
      const newFollowUpDate = followUpDate ? new Date(followUpDate) : null;
      const followUpChanged = oldFollowUpDate?.toDateString() !== newFollowUpDate?.toDateString();

      const updateData = { title, dealTitle, email, content, image, status, followUpDate: newFollowUpDate, followUpComment, lastReminderAt: null, lastUpdatedBy: req.user._id };
      if (req.files?.length > 0) {
        const newAttachments = req.files.map(f => ({ name: f.originalname, path: f.path, type: f.mimetype, size: f.size, uploadedAt: new Date() }));
        updateData.attachments = [...(original.attachments || []), ...newAttachments];
      }
      if (status && status !== original.status) {
        updateData.$push = { statusHistory: { status, changedAt: new Date(), changedBy: req.user._id } };
      }

      const updated = await Proposal.findByIdAndUpdate(id, updateData, { new: true, runValidators: true })
        .populate({ path: "deal", populate: { path: "assignedTo" } });

      if (followUpChanged && original.deal?.assignedTo)
        await deleteNotificationsByEntity("proposal", id, original.deal.assignedTo._id, tDB);

      res.json({ message: "Proposal updated", proposal: updated });
    } catch (error) {
      console.error("Update Error:", error);
      res.status(500).json({ error: error.message });
    }
  },

  deleteProposal: async (req, res) => {
    const { id } = req.params;
    try {
      const { Proposal, Notification } = getModels(req);
      const tDB = req.tenantDB || null;
      const proposal = await Proposal.findById(id).populate({ path: "deal", populate: { path: "assignedTo" } });
      if (!proposal) return res.status(404).json({ error: "Proposal not found" });

      if (proposal.deal?.assignedTo)
        await deleteNotificationsByEntity("proposal", id, proposal.deal.assignedTo._id, tDB);
      await Notification.deleteMany({ "meta.proposalId": id });
      await Proposal.findByIdAndDelete(id);
      res.json({ message: "Proposal and related notifications deleted successfully" });
    } catch (error) {
      console.error("Delete Error:", error);
      res.status(500).json({ error: error.message });
    }
  },

  bulkDeleteProposals: async (req, res) => {
    try {
      const { ids } = req.body;
      if (!ids || !Array.isArray(ids) || ids.length === 0)
        return res.status(400).json({ success: false, message: "Please provide an array of proposal IDs to delete" });

      const { Proposal, Notification } = getModels(req);
      const tDB = req.tenantDB || null;
      const toDelete = await Proposal.find({ _id: { $in: ids } }).populate({ path: "deal", populate: { path: "assignedTo" } });
      if (toDelete.length === 0) return res.status(404).json({ success: false, message: "No proposals found to delete" });

      for (const proposal of toDelete) {
        if (proposal.deal?.assignedTo)
          await deleteNotificationsByEntity("proposal", proposal._id, proposal.deal.assignedTo._id, tDB);
        await Notification.deleteMany({ "meta.proposalId": proposal._id });
      }
      const result = await Proposal.deleteMany({ _id: { $in: ids } });
      res.status(200).json({ success: true, message: `${result.deletedCount} proposal(s) deleted successfully`, deletedCount: result.deletedCount });
    } catch (error) {
      console.error("Bulk delete proposals error:", error);
      res.status(500).json({ success: false, message: "Failed to delete proposals", error: error.message });
    }
  },

  getProposal: async (req, res) => {
    const { id } = req.params;
    try {
      const { Proposal } = getModels(req);
      const proposal = await Proposal.findById(id).populate("deal");
      if (!proposal) return res.status(404).json({ error: "Proposal not found" });
      res.json(proposal);
    } catch (error) {
      console.error("Fetch Error:", error);
      res.status(500).json({ error: error.message });
    }
  },

  updateProposalFollowUp: async (req, res) => {
    const { id } = req.params;
    const { followUpDate, followUpComment } = req.body;
    try {
      const { Proposal } = getModels(req);
      const tDB = req.tenantDB || null;
      const proposal = await Proposal.findById(id).populate({ path: "deal", populate: { path: "assignedTo" } });
      if (!proposal) return res.status(404).json({ error: "Proposal not found" });

      const oldDate = proposal.followUpDate;
      const newDate = followUpDate ? new Date(followUpDate) : null;
      const dateChanged = !oldDate || !newDate || oldDate.toISOString() !== newDate.toISOString();

      proposal.followUpDate = newDate;
      proposal.followUpComment = followUpComment || proposal.followUpComment;
      proposal.lastReminderAt = null;
      if (dateChanged) {
        proposal.followUpHistory = [...(proposal.followUpHistory || []), { date: new Date(), followUpDate: newDate, followUpComment: followUpComment || "", changedBy: req.user?._id, action: oldDate ? "Updated" : "Created" }];
      }
      await proposal.save();

      if (dateChanged && proposal.deal?.assignedTo) {
        await deleteNotificationsByEntity("proposal", id, proposal.deal.assignedTo._id, tDB);
        await sendNotification(proposal.deal.assignedTo._id, `Proposal follow-up scheduled: ${proposal.title}`, "followup",
          { proposalId: proposal._id, proposalTitle: proposal.title, dealId: proposal.deal?._id, profileImage: proposal.deal?.assignedTo?.profileImage },
          { title: "Proposal Follow-up", followUpDate: proposal.followUpDate }, tDB);
      }
      res.json({ message: "Follow-up updated", proposal });
    } catch (err) {
      console.error("FollowUp Update Error:", err);
      res.status(500).json({ error: err.message });
    }
  },
};
