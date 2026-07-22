import { getTenantModels } from "../models/tenant/index.js";

// Legacy (non-tenant) fallbacks — Task/Target/Meeting were built tenant-only
// from the start, so they simply aren't available on the legacy path.
import DealLegacy      from "../models/deals.model.js";
import ProposalLegacy  from "../models/proposal.model.js";
import InvoiceLegacy   from "../models/invoice.model.js";
import MassEmailLegacy from "../models/massEmail.model.js";
import DealNoteLegacy  from "../models/dealNote.model.js";
import UserLegacy      from "../models/user.model.js";

const getModels = (req) => {
  if (req.tenantDB) return getTenantModels(req.tenantDB);
  return {
    Deal: DealLegacy, Proposal: ProposalLegacy, Invoice: InvoiceLegacy,
    MassEmail: MassEmailLegacy, DealNote: DealNoteLegacy, User: UserLegacy,
    Task: null, Target: null, Meeting: null,
  };
};

const nameOf = (u) => (u ? `${u.firstName || ""} ${u.lastName || ""}`.trim() || "Unknown" : null);
const asPerson = (u) => (u ? { id: u._id, name: nameOf(u) } : null);

export default {
  // GET /deals/:id/activity — unified, always-live feed. Nothing here is
  // duplicated/stored — every event is read straight from its source
  // collection at request time, so proposal/invoice status changes made
  // elsewhere show up immediately with no sync step.
  getActivityLog: async (req, res) => {
    try {
      const { Deal, Proposal, Invoice, Meeting, DealNote, MassEmail } = getModels(req);
      const dealId = req.params.id;

      const deal = await Deal.findById(dealId)
        .populate("stageHistory.movedBy", "firstName lastName")
        .populate("followUpHistory.changedBy", "firstName lastName")
        .populate("attachments.uploadedBy", "firstName lastName")
        .populate("assignmentHistory.assignedTo", "firstName lastName")
        .populate("assignmentHistory.assignedBy", "firstName lastName");
      if (!deal) return res.status(404).json({ message: "Deal not found" });

      const events = [];

      (deal.stageHistory || []).forEach((h) => {
        events.push({
          type: "stage_change",
          description: `Stage moved to "${h.stage}"`,
          performedBy: asPerson(h.movedBy),
          timestamp: h.movedAt,
        });
      });

      (deal.assignmentHistory || []).forEach((h) => {
        events.push({
          type: "assignee_changed",
          description: `Deal reassigned to ${nameOf(h.assignedTo) || "Unknown"}`,
          performedBy: asPerson(h.assignedBy),
          timestamp: h.assignedAt,
        });
      });

      (deal.followUpHistory || []).forEach((h) => {
        events.push({
          type: "followup",
          description: `Follow-up ${h.action || "updated"}${h.outcome ? ` — ${h.outcome}` : ""}`,
          performedBy: asPerson(h.changedBy),
          timestamp: h.date,
        });
      });

      (deal.attachments || []).forEach((a) => {
        events.push({
          type: "attachment_uploaded",
          description: `Attachment uploaded: ${a.name}`,
          performedBy: asPerson(a.uploadedBy),
          timestamp: a.uploadedAt,
        });
      });

      const notes = await DealNote.find({ dealId })
        .populate("createdBy", "firstName lastName")
        .sort({ createdAt: -1 });
      notes.forEach((n) => {
        events.push({
          type: "note_added",
          description: `Note added: "${n.text.length > 120 ? n.text.slice(0, 120) + "…" : n.text}"`,
          performedBy: asPerson(n.createdBy),
          timestamp: n.createdAt,
        });
      });

      const proposals = await Proposal.find({ deal: dealId })
        .populate("createdBy", "firstName lastName")
        .populate("lastUpdatedBy", "firstName lastName")
        .populate("statusHistory.changedBy", "firstName lastName")
        .sort({ createdAt: -1 });
      proposals.forEach((p) => {
        const history = p.statusHistory || [];
        if (history.length > 0) {
          // One event per transition — status alone only ever shows the
          // current value, so without this a draft → success → no reply →
          // sent journey would collapse into a single "sent" entry here.
          events.push({
            type: "proposal_sent",
            description: `Proposal "${p.title}" created (${history[0].status})`,
            performedBy: asPerson(history[0].changedBy) || asPerson(p.createdBy),
            timestamp: history[0].changedAt || p.createdAt,
          });
          for (let i = 1; i < history.length; i++) {
            events.push({
              type: "proposal_status_changed",
              description: `Proposal "${p.title}" status changed to ${history[i].status}`,
              performedBy: asPerson(history[i].changedBy),
              timestamp: history[i].changedAt,
            });
          }
        } else {
          // Legacy proposals created before status history tracking existed
          // — fall back to the old collapsed created/last-changed pair
          // rather than losing all activity for pre-existing records.
          events.push({
            type: "proposal_sent",
            description: `Proposal "${p.title}" created (${p.status})`,
            performedBy: asPerson(p.createdBy),
            timestamp: p.createdAt,
          });
          if (p.updatedAt && p.updatedAt.getTime() !== p.createdAt.getTime()) {
            events.push({
              type: "proposal_status_changed",
              description: `Proposal "${p.title}" status: ${p.status}`,
              performedBy: asPerson(p.lastUpdatedBy),
              timestamp: p.updatedAt,
            });
          }
        }
      });

      const invoices = await Invoice.find({ "items.deal": dealId })
        .populate("createdBy", "firstName lastName")
        .populate("lastUpdatedBy", "firstName lastName")
        .populate("statusHistory.changedBy", "firstName lastName")
        .sort({ createdAt: -1 });
      invoices.forEach((inv) => {
        const history = inv.statusHistory || [];
        if (history.length > 0) {
          // One event per transition — same reasoning as proposals: status
          // alone only shows the current value, so unpaid → partially_paid →
          // paid would otherwise collapse into a single "paid" entry here,
          // hiding the actual payment journey from whoever is reviewing it.
          events.push({
            type: "invoice_created",
            description: `Invoice #${inv.invoicenumber} created (${history[0].status})`,
            performedBy: asPerson(history[0].changedBy) || asPerson(inv.createdBy),
            timestamp: history[0].changedAt || inv.createdAt,
          });
          for (let i = 1; i < history.length; i++) {
            events.push({
              type: "invoice_status_changed",
              description: `Invoice #${inv.invoicenumber} status changed to ${history[i].status}${history[i].amountPaid ? ` (paid ${history[i].amountPaid})` : ""}`,
              performedBy: asPerson(history[i].changedBy),
              timestamp: history[i].changedAt,
            });
          }
        } else {
          // Legacy invoices created before status history tracking existed —
          // fall back to the old collapsed created/last-changed pair rather
          // than losing all activity for pre-existing records.
          events.push({
            type: "invoice_created",
            description: `Invoice #${inv.invoicenumber} created (${inv.status})`,
            performedBy: asPerson(inv.createdBy),
            timestamp: inv.createdAt,
          });
          if (inv.updatedAt && inv.updatedAt.getTime() !== inv.createdAt.getTime()) {
            events.push({
              type: "invoice_status_changed",
              description: `Invoice #${inv.invoicenumber} status: ${inv.status}${inv.amountPaid ? ` (paid ${inv.amountPaid})` : ""}`,
              performedBy: asPerson(inv.lastUpdatedBy),
              timestamp: inv.updatedAt,
            });
          }
        }
      });

      if (Meeting) {
        const meetings = await Meeting.find({ dealId })
          .populate("createdBy", "firstName lastName")
          .populate("cancelledBy", "firstName lastName")
          .sort({ createdAt: -1 });
        meetings.forEach((m) => {
          events.push({
            type: "meeting_scheduled",
            description: `Meeting "${m.title}" scheduled for ${new Date(m.startDateTime).toLocaleString()}`,
            performedBy: asPerson(m.createdBy),
            timestamp: m.createdAt,
          });
          if (m.status === "cancelled") {
            events.push({
              type: "meeting_cancelled",
              description: `Meeting "${m.title}" cancelled`,
              performedBy: asPerson(m.cancelledBy),
              timestamp: m.cancelledAt || m.updatedAt,
            });
          }
        });
      }

      if (deal.email) {
        // Same match as getDealEmails below — recipients is a plain string
        // array with no dealId link, so the deal's own contact email is the
        // only way to tie a campaign send back to this deal.
        const emails = await MassEmail.find({ recipients: deal.email })
          .populate("createdBy", "firstName lastName")
          .populate("cancelledBy", "firstName lastName")
          .sort({ createdAt: -1 });
        emails.forEach((e) => {
          events.push({
            type: e.status === "sent" ? "email_sent" : "email_scheduled",
            description: `Email "${e.subject}" ${e.status === "sent" ? "sent" : e.status} to ${deal.email}`,
            performedBy: asPerson(e.createdBy),
            timestamp: e.createdAt,
          });
          if (e.status === "cancelled") {
            events.push({
              type: "email_cancelled",
              description: `Email "${e.subject}" cancelled`,
              performedBy: asPerson(e.cancelledBy),
              timestamp: e.cancelledAt || e.updatedAt,
            });
          }
        });
      }

      // Newest first — most recent event (e.g. "Deal Won") at the top,
      // scrolling down moves further into the past.
      events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      res.status(200).json({ dealId, activity: events });
    } catch (err) {
      console.error("Get deal activity log error:", err);
      res.status(500).json({ message: err.message });
    }
  },

  // GET /deals/:id/notes — the original single deal.notes field is shown as
  // the oldest/seed entry, followed by the DealNote thread, newest first.
  getNotes: async (req, res) => {
    try {
      const { Deal, DealNote } = getModels(req);
      const dealId = req.params.id;

      const deal = await Deal.findById(dealId).populate("notesUpdatedBy", "firstName lastName");
      if (!deal) return res.status(404).json({ message: "Deal not found" });

      const notes = await DealNote.find({ dealId })
        .populate("createdBy", "firstName lastName")
        .sort({ createdAt: -1 });

      const list = notes.map((n) => ({
        _id: n._id,
        text: n.text,
        createdBy: asPerson(n.createdBy),
        createdAt: n.createdAt,
      }));

      if (deal.notes && deal.notes.trim() !== "") {
        list.push({
          _id: "seed",
          text: deal.notes,
          createdBy: asPerson(deal.notesUpdatedBy),
          createdAt: deal.notesUpdatedAt || deal.createdAt,
          seed: true,
        });
      }

      res.status(200).json({ dealId, notes: list });
    } catch (err) {
      console.error("Get deal notes error:", err);
      res.status(500).json({ message: err.message });
    }
  },

  addNote: async (req, res) => {
    try {
      const { Deal, DealNote } = getModels(req);
      const dealId = req.params.id;
      const { text } = req.body;
      if (!text || !text.trim()) return res.status(400).json({ message: "Note text is required" });

      const deal = await Deal.findById(dealId).select("_id");
      if (!deal) return res.status(404).json({ message: "Deal not found" });

      const note = await DealNote.create({ dealId, text: text.trim(), createdBy: req.user._id });
      await note.populate("createdBy", "firstName lastName");

      res.status(201).json({
        message: "Note added",
        note: { _id: note._id, text: note.text, createdBy: asPerson(note.createdBy), createdAt: note.createdAt },
      });
    } catch (err) {
      console.error("Add deal note error:", err);
      res.status(500).json({ message: err.message });
    }
  },

  // GET /deals/:id/highlights — pending Tasks/Targets linked to this deal,
  // for the Deal Details tab's highlight banner. Read-only against the
  // existing Task/Target collections, nothing duplicated.
  getHighlights: async (req, res) => {
    try {
      const { Task, Target } = getModels(req);
      const dealId = req.params.id;

      const pendingTasks = Task
        ? await Task.find({
            $or: [{ dealRef: dealId }, { dealRefs: dealId }],
            status: { $ne: "Completed" },
            archived: { $ne: true },
          })
            .select("title description status priority dueDate assignedTo")
            .populate("assignedTo", "firstName lastName")
            .sort({ dueDate: 1 })
        : [];

      const pendingTargets = Target
        ? await Target.find({ linkedDeals: dealId, expiredAt: null })
            .select("description period startDate endDate targetDeals salesPerson")
            .populate("salesPerson", "firstName lastName")
            .sort({ endDate: 1 })
        : [];

      res.status(200).json({ dealId, pendingTasks, pendingTargets });
    } catch (err) {
      console.error("Get deal highlights error:", err);
      res.status(500).json({ message: err.message });
    }
  },

  // GET /deals/:id/proposals — live read against Proposal, never copied.
  getDealProposals: async (req, res) => {
    try {
      const { Proposal } = getModels(req);
      const proposals = await Proposal.find({ deal: req.params.id })
        .populate("createdBy", "firstName lastName")
        .populate("lastUpdatedBy", "firstName lastName")
        .sort({ createdAt: -1 });
      res.status(200).json(proposals);
    } catch (err) {
      console.error("Get deal proposals error:", err);
      res.status(500).json({ message: err.message });
    }
  },

  // GET /deals/:id/invoices — live read against Invoice, never copied.
  getDealInvoices: async (req, res) => {
    try {
      const { Invoice } = getModels(req);
      // items.deal must be populated to an object (not left as a bare id) —
      // InvoiceModal's own edit-prefill reads `editingInvoice.items[0].deal._id`
      // (matching invoice.controller.js's getAllInvoices), and without this it
      // silently resolves to undefined, failing "Deal is required" validation.
      const invoices = await Invoice.find({ "items.deal": req.params.id })
        .populate("assignTo", "firstName lastName email")
        .populate("createdBy", "firstName lastName")
        .populate("lastUpdatedBy", "firstName lastName")
        .populate("items.deal", "dealName value stage")
        .sort({ createdAt: -1 });
      res.status(200).json(invoices);
    } catch (err) {
      console.error("Get deal invoices error:", err);
      res.status(500).json({ message: err.message });
    }
  },

  // GET /deals/:id/meetings — tenant-only, matches meetingSchema.dealId.
  getDealMeetings: async (req, res) => {
    try {
      const { Meeting } = getModels(req);
      if (!Meeting) return res.status(200).json([]);
      const meetings = await Meeting.find({ dealId: req.params.id })
        .populate("createdBy", "firstName lastName")
        .sort({ startDateTime: -1 });
      res.status(200).json(meetings);
    } catch (err) {
      console.error("Get deal meetings error:", err);
      res.status(500).json({ message: err.message });
    }
  },

  // GET /deals/:id/emails — massEmailSchema has no deal link, so this matches
  // on the deal's own contact email against MassEmail.recipients.
  getDealEmails: async (req, res) => {
    try {
      const { Deal, MassEmail } = getModels(req);
      const deal = await Deal.findById(req.params.id).select("email");
      if (!deal) return res.status(404).json({ message: "Deal not found" });
      if (!deal.email) return res.status(200).json([]);

      const emails = await MassEmail.find({ recipients: deal.email })
        .populate("createdBy", "firstName lastName")
        .sort({ createdAt: -1 });
      res.status(200).json(emails);
    } catch (err) {
      console.error("Get deal emails error:", err);
      res.status(500).json({ message: err.message });
    }
  },

  // GET /deals/:id/score — provisional v1 composite: stage progress +
  // proposal/invoice presence + activity recency. Placeholder per explicit
  // request to just reserve the top-right corner slot for now; formula is
  // expected to be refined later.
  getDealScore: async (req, res) => {
    try {
      const { Deal, Proposal, Invoice } = getModels(req);
      const dealId = req.params.id;
      const deal = await Deal.findById(dealId).select("stage updatedAt");
      if (!deal) return res.status(404).json({ message: "Deal not found" });

      const STAGE_WEIGHT = {
        "Qualification": 10,
        "Proposal Sent-Negotiation": 40,
        "Invoice Sent": 65,
        "Closed Won": 100,
        "Closed Lost": 0,
        "Rejected": 0,
      };

      let score = STAGE_WEIGHT[deal.stage] ?? 10;

      const [hasProposal, hasInvoice] = await Promise.all([
        Proposal.exists({ deal: dealId }),
        Invoice.exists({ "items.deal": dealId }),
      ]);
      if (hasProposal) score += 5;
      if (hasInvoice) score += 10;

      const daysSinceActivity = deal.updatedAt
        ? (Date.now() - new Date(deal.updatedAt).getTime()) / 86400000
        : Infinity;
      if (daysSinceActivity > 30) score -= 15;
      else if (daysSinceActivity > 14) score -= 5;

      score = Math.max(0, Math.min(100, Math.round(score)));

      res.status(200).json({
        dealId,
        score,
        note: "Provisional v1 score (stage progress + proposal/invoice presence + activity recency).",
      });
    } catch (err) {
      console.error("Get deal score error:", err);
      res.status(500).json({ message: err.message });
    }
  },
};
