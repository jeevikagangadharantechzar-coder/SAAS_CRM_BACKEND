import { thereAre, isAdmin, hasPermission, noPermission, getTerms, resolveOwnerScope, has, matchesWord, formatDateTime, fullName, plural, regexOf } from "../helpers.js";

const WORDS = ["meeting", "meetings", "upcoming", "next", "cancelled", "canceled", "scheduled", "completed", "zoom", "google", "meet", "call", "calls"];

export default {
  name: "meetings",

  match: ({ lower }) => matchesWord(lower, "meetings?|zoom calls?|google meet") && !has(lower, "target"),

  handle: async (ctx) => {
    const { Meeting, Deal, Lead } = ctx.models;
    if (!Meeting) return null;
    if (!hasPermission(ctx, "meetings", "schedule_view")) return noPermission("meetings", "Meetings");

    const { lower, dateFilter, dateLabel, userId } = ctx;
    const terms = getTerms(ctx, WORDS);
    const scope = await resolveOwnerScope(ctx, terms);
    if (scope.denied) return noPermission("meetings-by-salesperson", "other users' meetings");

    const query = {};
    let label = "";
    if (has(lower, "cancelled", "canceled")) { query.status = "cancelled"; label = "cancelled "; }
    else if (has(lower, "completed", "done", "finished")) { query.status = "completed"; label = "completed "; }

    // A date ("today", "this week") shows every meeting in that window; otherwise default to upcoming.
    if (dateFilter) query.startDateTime = dateFilter;
    else if (!query.status) {
      query.status = "scheduled";
      query.startDateTime = { $gte: new Date() };
      label = "upcoming ";
    }

    // Meetings belong to whoever created them, or to the deal/lead owner.
    if (scope.ids) {
      const [deals, leads] = await Promise.all([
        Deal ? Deal.find({ assignedTo: { $in: scope.ids } }).select("_id") : [],
        Lead ? Lead.find({ assignTo: { $in: scope.ids } }).select("_id") : [],
      ]);
      query.$or = [
        { createdBy: { $in: scope.ids } },
        { dealId: { $in: deals.map((d) => d._id) } },
        { leadId: { $in: leads.map((l) => l._id) } },
      ];
    }

    // "meetings with acme" -> match the linked deal or lead by name
    const nameTerm = !scope.names && terms[0];
    if (nameTerm) {
      const [deals, leads] = await Promise.all([
        Deal ? Deal.find({ $or: [{ dealName: regexOf(nameTerm) }, { companyName: regexOf(nameTerm) }] }).select("_id") : [],
        Lead ? Lead.find({ $or: [{ leadName: regexOf(nameTerm) }, { companyName: regexOf(nameTerm) }] }).select("_id") : [],
      ]);
      const refFilter = { $or: [{ title: regexOf(nameTerm) }, { dealId: { $in: deals.map((d) => d._id) } }, { leadId: { $in: leads.map((l) => l._id) } }] };
      if (query.$or) { query.$and = [{ $or: query.$or }, refFilter]; delete query.$or; }
      else Object.assign(query, refFilter);
    }

    const meetings = await Meeting.find(query)
      .populate("createdBy", "firstName lastName")
      .populate("dealId", "dealName companyName")
      .populate("leadId", "leadName companyName")
      .sort({ startDateTime: query.status === "completed" || query.status === "cancelled" ? -1 : 1 })
      .limit(50);

    const owner = scope.names ? `${scope.names} has` : isAdmin(ctx) && !scope.ids ? thereAre(meetings.length) : "You have";
    const suffix = nameTerm && meetings.length ? ` matching "${nameTerm}"` : "";
    let message = `${owner} ${plural(meetings.length, `${label}meeting`)}${suffix}${dateLabel}.`;
    if (meetings.length && label === "upcoming ") message += ` Next: "${meetings[0].title}" on ${formatDateTime(meetings[0].startDateTime)}.`;

    return {
      intent: `meetings-${query.status || "list"}`,
      message,
      data: meetings.map((m) => ({
        _id: m._id,
        type: "meeting",
        name: m.title,
        status: m.status,
        detail: `${formatDateTime(m.startDateTime)} · ${m.provider === "zoom" ? "Zoom" : "Google Meet"}`,
        companyName: m.dealId?.dealName || m.leadId?.leadName || null,
        link: m.status === "scheduled" ? m.meetLink : null,
        handledBy: fullName(m.createdBy) || "Unassigned",
        createdAt: m.createdAt,
      })),
    };
  },
};
