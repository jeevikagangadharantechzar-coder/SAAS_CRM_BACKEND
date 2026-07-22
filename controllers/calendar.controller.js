import { getTenantModels } from "../models/tenant/index.js";
import { getTenantPlanFeatures, isFeatureEnabled } from "../utils/planFeatures.js";

// Legacy (non-tenant) fallbacks — Task/Target/Meeting were built tenant-only
// from the start, so they simply aren't available on the legacy path (same
// gap dealDetail.controller.js already has to work around).
import DealLegacy         from "../models/deals.model.js";
import LeadLegacy         from "../models/leads.model.js";
import ProposalLegacy     from "../models/proposal.model.js";
import InvoiceLegacy      from "../models/invoice.model.js";
import MassEmailLegacy    from "../models/massEmail.model.js";
import CalendarNoteLegacy from "../models/calendarNote.model.js";

const getModels = (req) => {
  if (req.tenantDB) return getTenantModels(req.tenantDB);
  return {
    Deal: DealLegacy, Lead: LeadLegacy, Proposal: ProposalLegacy, Invoice: InvoiceLegacy,
    MassEmail: MassEmailLegacy, CalendarNote: CalendarNoteLegacy,
    Task: null, Target: null, Meeting: null,
  };
};

export default {
  // GET /calendar?start=&end= — one merged, role-scoped feed across every
  // dated CRM record (tasks, targets, lead & deal follow-ups, invoices,
  // proposals, meetings, scheduled emails) plus the current user's own
  // personal sticky notes. Read-only aggregation, nothing stored — exactly
  // the same "always live, never duplicated" principle the Deal Activity Log
  // (dealDetail.controller.js) already uses.
  getCalendarEvents: async (req, res) => {
    try {
      const { Deal, Lead, Proposal, Invoice, Meeting, Task, Target, MassEmail, CalendarNote } = getModels(req);
      const { start, end } = req.query;
      if (!start || !end) return res.status(400).json({ message: "start and end query params are required" });

      const rangeStart = new Date(start);
      const rangeEnd = new Date(end);
      const isAdmin = req.user.role?.name === "Admin";
      const userId = req.user._id;

      // The whole /calendar route is already gated on schedule_view, but
      // that alone isn't enough — this endpoint aggregates data straight out
      // of other modules' collections, so a plan that disables e.g.
      // Meetings must not have meeting events leak through here just
      // because Calendar itself is still enabled.
      const planFeatures = await getTenantPlanFeatures(req);

      const events = [];

      // ── Tasks — scope: assignedTo
      if (Task && isFeatureEnabled(planFeatures, "task_management")) {
        const taskQuery = {
          dueDate: { $gte: rangeStart, $lte: rangeEnd },
          archived: { $ne: true },
          ...(isAdmin ? {} : { assignedTo: userId }),
        };
        const tasks = await Task.find(taskQuery).select("title description status dueDate dealRef dealRefs assignedTo");
        tasks.forEach((t) => {
          const dealId = t.dealRef || t.dealRefs?.[0] || null;
          events.push({
            id: `task-${t._id}`,
            type: "task",
            title: t.title,
            date: t.dueDate,
            status: t.status,
            pending: t.status !== "Completed" && new Date(t.dueDate) < new Date(),
            dealId,
            // Always Task Management, same as Target always goes to Target
            // Management — a linked deal is just context, not a redirect target.
            link: { page: "task-management" },
          });
        });
      }

      // ── Targets — scope: salesPerson. Period overlap, not a single date —
      // a target spanning the visible range counts even if neither
      // endpoint falls exactly inside it.
      if (Target && isFeatureEnabled(planFeatures, "target_management")) {
        const targetQuery = {
          startDate: { $lte: rangeEnd },
          endDate: { $gte: rangeStart },
          ...(isAdmin ? {} : { salesPerson: userId }),
        };
        const targets = await Target.find(targetQuery).select("description period startDate endDate expiredAt salesPerson");
        targets.forEach((tg) => {
          events.push({
            id: `target-${tg._id}`,
            type: "target",
            title: tg.description || `${tg.period} target`,
            date: tg.startDate,
            endDate: tg.endDate,
            status: tg.expiredAt ? "expired" : "active",
            pending: !tg.expiredAt && new Date(tg.endDate) < new Date(),
            link: { page: "target-management" },
          });
        });
      }

      // ── Deal follow-ups — scope: assignedTo
      if (isFeatureEnabled(planFeatures, ["deals_all", "deals_pipeline"])) {
        const dealQuery = {
          followUpDate: { $gte: rangeStart, $lte: rangeEnd },
          ...(isAdmin ? {} : { assignedTo: userId }),
        };
        const deals = await Deal.find(dealQuery).select("dealName followUpDate stage assignedTo");
        deals.forEach((d) => {
          events.push({
            id: `followup-${d._id}`,
            type: "followup",
            title: `Follow-up: ${d.dealName}`,
            date: d.followUpDate,
            status: d.stage,
            pending: new Date(d.followUpDate) < new Date(),
            dealId: d._id,
            dealName: d.dealName,
            link: { page: "deal", dealId: d._id },
          });
        });
      }

      // ── Lead follow-ups — scope: assignTo. Same shape as Deal follow-ups
      // above, just Lead's own field names (assignTo singular, leadName).
      if (isFeatureEnabled(planFeatures, "leads")) {
        const leadQuery = {
          followUpDate: { $gte: rangeStart, $lte: rangeEnd },
          ...(isAdmin ? {} : { assignTo: userId }),
        };
        const leads = await Lead.find(leadQuery).select("leadName followUpDate status assignTo");
        leads.forEach((l) => {
          events.push({
            id: `lead-followup-${l._id}`,
            type: "lead_followup",
            title: `Lead Follow-up: ${l.leadName}`,
            date: l.followUpDate,
            status: l.status,
            pending: l.status !== "Converted" && l.status !== "Rejected" && new Date(l.followUpDate) < new Date(),
            leadId: l._id,
            leadName: l.leadName,
            link: { page: "lead", leadId: l._id },
          });
        });
      }

      // ── Invoices — scope: assignTo
      if (isFeatureEnabled(planFeatures, "invoices")) {
        const invoiceQuery = {
          dueDate: { $gte: rangeStart, $lte: rangeEnd },
          ...(isAdmin ? {} : { assignTo: userId }),
        };
        const invoices = await Invoice.find(invoiceQuery)
          .populate("items.deal", "dealName")
          .select("invoicenumber dueDate status items assignTo");
        invoices.forEach((inv) => {
          const dealRef = inv.items?.[0]?.deal;
          events.push({
            id: `invoice-${inv._id}`,
            type: "invoice",
            title: `Invoice #${inv.invoicenumber}`,
            date: inv.dueDate,
            status: inv.status,
            pending: inv.status !== "paid" && new Date(inv.dueDate) < new Date(),
            dealId: dealRef?._id || null,
            dealName: dealRef?.dealName || null,
            // The specific invoice's own view page, not just the general list.
            link: { page: "invoice", invoiceId: inv._id },
          });
        });
      }

      // ── Proposals — no direct owner field; ownership resolves through
      // the linked deal's assignedTo (same resolution getAllProposals/
      // getDraftProposals in proposal.controller.js already use).
      if (isFeatureEnabled(planFeatures, "proposal")) {
        const proposalQuery = { followUpDate: { $gte: rangeStart, $lte: rangeEnd } };
        let proposals = await Proposal.find(proposalQuery)
          .populate("deal", "dealName assignedTo")
          .select("title followUpDate status deal");
        if (!isAdmin) {
          proposals = proposals.filter((p) => String(p.deal?.assignedTo) === String(userId));
        }
        proposals.forEach((p) => {
          events.push({
            id: `proposal-${p._id}`,
            type: "proposal",
            title: `Proposal: ${p.title}`,
            date: p.followUpDate,
            status: p.status,
            pending: p.status !== "success" && p.status !== "rejection" && new Date(p.followUpDate) < new Date(),
            dealId: p.deal?._id || null,
            dealName: p.deal?.dealName || null,
            // Always the proposal's own view page — a linked deal is just
            // context here, not where a proposal event should navigate to.
            link: { page: "proposal", proposalId: p._id },
          });
        });
      }

      // ── Meetings — scope: createdBy
      if (Meeting && isFeatureEnabled(planFeatures, "meetings")) {
        const meetingQuery = {
          startDateTime: { $gte: rangeStart, $lte: rangeEnd },
          ...(isAdmin ? {} : { createdBy: userId }),
        };
        const meetings = await Meeting.find(meetingQuery).select("title startDateTime endDateTime status dealId createdBy");
        meetings.forEach((m) => {
          events.push({
            id: `meeting-${m._id}`,
            type: "meeting",
            title: m.title,
            date: m.startDateTime,
            endDate: m.endDateTime,
            status: m.status,
            pending: m.status === "scheduled" && new Date(m.startDateTime) < new Date(),
            dealId: m.dealId || null,
            link: { page: "meetings" },
          });
        });
      }

      // ── Scheduled emails — scope: createdBy. Only "scheduled" (not yet
      // sent) ones make sense on a forward-looking calendar.
      if (isFeatureEnabled(planFeatures, "email_campaigns")) {
        const emailQuery = {
          scheduledFor: { $gte: rangeStart, $lte: rangeEnd },
          status: "scheduled",
          ...(isAdmin ? {} : { createdBy: userId }),
        };
        const emails = await MassEmail.find(emailQuery).select("subject scheduledFor status createdBy");
        emails.forEach((e) => {
          events.push({
            id: `email-${e._id}`,
            type: "email",
            title: `Email: ${e.subject}`,
            date: e.scheduledFor,
            status: e.status,
            pending: new Date(e.scheduledFor) < new Date(),
            // The specific scheduled email's own edit page, not just the general list.
            link: { page: "email", emailId: e._id },
          });
        });
      }

      // ── Personal sticky notes — always scoped to the current user only,
      // regardless of Admin/Sales. Not a team-visibility record like
      // everything above; it's a private "don't let me forget" reminder.
      {
        const notes = await CalendarNote.find({
          date: { $gte: rangeStart, $lte: rangeEnd },
          createdBy: userId,
        }).select("text date");
        notes.forEach((n) => {
          events.push({
            id: `note-${n._id}`,
            type: "note",
            title: n.text,
            date: n.date,
            editable: true,
            link: { page: "note" },
          });
        });
      }

      res.status(200).json({ events });
    } catch (err) {
      console.error("Get calendar events error:", err);
      res.status(500).json({ message: err.message });
    }
  },

  // POST /calendar/notes — { date, text }
  addCalendarNote: async (req, res) => {
    try {
      const { CalendarNote } = getModels(req);
      const { date, text } = req.body;
      if (!date || !text?.trim()) return res.status(400).json({ message: "date and text are required" });

      const note = await CalendarNote.create({ date: new Date(date), text: text.trim(), createdBy: req.user._id });
      res.status(201).json({
        message: "Note added",
        note: { id: `note-${note._id}`, type: "note", title: note.text, date: note.date, editable: true, link: { page: "note" } },
      });
    } catch (err) {
      console.error("Add calendar note error:", err);
      res.status(500).json({ message: err.message });
    }
  },

  // PUT /calendar/notes/:id — { text } — only the note's own creator can edit it
  updateCalendarNote: async (req, res) => {
    try {
      const { CalendarNote } = getModels(req);
      const { text } = req.body;
      if (!text?.trim()) return res.status(400).json({ message: "text is required" });

      const note = await CalendarNote.findById(req.params.id);
      if (!note) return res.status(404).json({ message: "Note not found" });
      if (String(note.createdBy) !== String(req.user._id))
        return res.status(403).json({ message: "You can only edit your own notes" });

      note.text = text.trim();
      await note.save();
      res.status(200).json({ message: "Note updated", note: { id: `note-${note._id}`, type: "note", title: note.text, date: note.date, editable: true, link: { page: "note" } } });
    } catch (err) {
      console.error("Update calendar note error:", err);
      res.status(500).json({ message: err.message });
    }
  },

  // DELETE /calendar/notes/:id — only the note's own creator can delete it
  deleteCalendarNote: async (req, res) => {
    try {
      const { CalendarNote } = getModels(req);
      const note = await CalendarNote.findById(req.params.id);
      if (!note) return res.status(404).json({ message: "Note not found" });
      if (String(note.createdBy) !== String(req.user._id))
        return res.status(403).json({ message: "You can only delete your own notes" });

      await note.deleteOne();
      res.status(200).json({ message: "Note deleted" });
    } catch (err) {
      console.error("Delete calendar note error:", err);
      res.status(500).json({ message: err.message });
    }
  },
};
