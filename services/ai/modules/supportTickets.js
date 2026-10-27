import { thereAre, isAdmin, getTerms, resolveOwnerScope, has, matchesWord, formatDate, fullName, plural, regexOf, noPermission } from "../helpers.js";

const WORDS = ["ticket", "tickets", "support", "complaint", "complaints", "open", "closed", "resolved", "critical", "high", "medium", "low", "priority", "technical", "billing", "bug", "bugs", "feature", "request", "general"];
const CATEGORIES = { technical: "Technical", billing: "Billing", "feature request": "Feature Request", bug: "Bug", general: "General" };

export default {
  name: "support-tickets",

  match: ({ lower }) => matchesWord(lower, "tickets?|support tickets?|complaints?|support requests?"),

  handle: async (ctx) => {
    const { SupportTicket, Deal } = ctx.models;
    if (!SupportTicket) return null;

    const { lower, dateFilter, dateLabel } = ctx;
    const terms = getTerms(ctx, WORDS);
    const scope = await resolveOwnerScope(ctx, terms);
    if (scope.denied) return noPermission("tickets-by-salesperson", "other users' tickets");

    const query = {};
    // A ticket belongs to whoever raised it, or to the owner of the linked deal.
    if (scope.ids) {
      const deals = Deal ? await Deal.find({ assignedTo: { $in: scope.ids } }).select("_id") : [];
      query.$or = [{ createdBy: { $in: scope.ids } }, { dealId: { $in: deals.map((d) => d._id) } }];
    }

    let label = "";
    if (matchesWord(lower, "closed|resolved")) { query.status = "Closed"; label = "closed "; }
    else if (matchesWord(lower, "open|pending|unresolved")) { query.status = "Open"; label = "open "; }

    const priority = ["critical", "high", "medium", "low"].find((p) => matchesWord(lower, p));
    if (priority) { query.priority = priority[0].toUpperCase() + priority.slice(1); label += `${priority} priority `; }

    const categoryKey = Object.keys(CATEGORIES).find((k) => matchesWord(lower, `${k}s?`));
    if (categoryKey) query.category = CATEGORIES[categoryKey];
    if (dateFilter) query.createdAt = dateFilter;

    // Ticket number ("TKT-202610-0003") or company name
    const term = !scope.names && terms[0];
    if (term) {
      const termFilter = { $or: [{ ticketNumber: regexOf(term) }, { companyName: regexOf(term) }, { subject: regexOf(term) }] };
      if (query.$or) { query.$and = [{ $or: query.$or }, termFilter]; delete query.$or; }
      else Object.assign(query, termFilter);
    }

    const tickets = await SupportTicket.find(query).populate("createdBy", "firstName lastName").sort({ createdAt: -1 }).limit(50);

    const owner = scope.names ? `${scope.names} has` : isAdmin(ctx) && !scope.ids ? thereAre(tickets.length) : "You have";
    let message = `${owner} ${plural(tickets.length, `${label}${categoryKey ? `${CATEGORIES[categoryKey]} ` : ""}support ticket`)}${term ? ` matching "${term}"` : ""}${dateLabel}.`;
    const closedWithTime = tickets.filter((t) => t.status === "Closed" && t.resolutionTimeHours);
    if (query.status === "Closed" && closedWithTime.length) {
      const avg = closedWithTime.reduce((s, t) => s + t.resolutionTimeHours, 0) / closedWithTime.length;
      message += ` Average resolution time: ${avg.toFixed(1)} hours.`;
    }

    return {
      intent: `support-tickets${query.status ? `-${query.status.toLowerCase()}` : ""}`,
      message,
      data: tickets.map((t) => ({
        _id: t._id,
        type: "ticket",
        name: `${t.ticketNumber || "Ticket"} · ${t.subject}`,
        status: t.status,
        priority: t.priority,
        companyName: t.companyName,
        detail: `${t.category} · opened ${formatDate(t.openedAt || t.createdAt)}${t.closedAt ? ` · closed ${formatDate(t.closedAt)}` : ""}`,
        handledBy: fullName(t.createdBy) || "Unassigned",
        createdAt: t.createdAt,
      })),
    };
  },
};
