import { isAdmin, hasPermission, noPermission, getTerms, resolveOwnerScope, matchesWord } from "../helpers.js";

const WORDS = ["sales", "report", "reports", "summary", "overview", "performance", "conversion", "rate", "win", "dashboard", "stats", "statistics", "kpi", "kpis", "doing", "numbers"];
const OPEN_EXCLUDED = ["Closed Won", "Closed Lost", "Rejected"];

const pct = (part, total) => (total > 0 ? `${((part / total) * 100).toFixed(1)}%` : "0%");

// One-line sales summary: leads, conversion, deals won/lost, pipeline and revenue.
export default {
  name: "sales-report",

  match: ({ lower }) =>
    matchesWord(lower, "sales reports?|performance reports?|sales summary|summary|overview|conversion rate|win rate|my performance|how am i doing|my stats|sales stats|kpi summary"),

  handle: async (ctx) => {
    const { Lead, Deal, Invoice } = ctx.models;
    if (!Lead || !Deal) return null;

    const terms = getTerms(ctx, WORDS);
    const scope = await resolveOwnerScope(ctx, terms);
    if (scope.denied) return noPermission("sales-report", "other users' sales reports");
    // Team-wide numbers need the Reports permission; your own numbers are always visible.
    if (!scope.ids && !hasPermission(ctx, "reports")) return noPermission("sales-report", "team sales reports");

    let { dateFilter, dateLabel } = ctx;
    if (!dateFilter) {
      const now = new Date();
      dateFilter = { $gte: new Date(now.getFullYear(), now.getMonth(), 1), $lte: now };
      dateLabel = " this month";
    }

    const leadQ = { createdAt: dateFilter, ...(scope.ids && { assignTo: { $in: scope.ids } }) };
    const dealOwner = scope.ids ? { assignedTo: { $in: scope.ids } } : {};

    const [totalLeads, convertedLeads, newDeals, wonDeals, lostDeals, openDeals, invoices] = await Promise.all([
      Lead.countDocuments(leadQ),
      Lead.countDocuments({ ...leadQ, status: "Converted" }),
      Deal.countDocuments({ ...dealOwner, createdAt: dateFilter }),
      Deal.find({ ...dealOwner, stage: "Closed Won", $or: [{ wonAt: dateFilter }, { wonAt: null, updatedAt: dateFilter }] }).select("value"),
      Deal.countDocuments({ ...dealOwner, stage: { $in: ["Closed Lost", "Rejected"] }, updatedAt: dateFilter }),
      Deal.find({ ...dealOwner, stage: { $nin: OPEN_EXCLUDED } }).select("value"),
      Invoice
        ? Invoice.find({ status: { $in: ["paid", "partially_paid"] }, createdAt: dateFilter, ...(scope.ids && { assignTo: { $in: scope.ids } }) }).select("total currency")
        : [],
    ]);

    const sum = (rows, field) => rows.reduce((s, r) => s + (Number(r[field]) || 0), 0);
    const wonValue = sum(wonDeals, "value");
    const pipelineValue = sum(openDeals, "value");
    const revenue = sum(invoices, "total");
    const currency = invoices[0]?.currency || "INR";
    const closed = wonDeals.length + lostDeals;

    const who = scope.names ? `${scope.names}'s` : isAdmin(ctx) && !scope.ids ? "Team" : "Your";
    const message =
      `${who} sales summary${dateLabel}: ${totalLeads} leads (${convertedLeads} converted, ${pct(convertedLeads, totalLeads)} conversion), ` +
      `${newDeals} new deals, ${wonDeals.length} won worth ${wonValue.toLocaleString()} and ${lostDeals} lost (${pct(wonDeals.length, closed)} win rate). ` +
      `Open pipeline: ${openDeals.length} deals worth ${pipelineValue.toLocaleString()}. Revenue collected: ${revenue.toLocaleString()} ${currency}.`;

    const stat = (name, value, detail) => ({ _id: name, type: "stat", name, value: String(value), detail, handledBy: null });

    return {
      intent: "sales-report",
      message,
      data: [
        stat("Leads", totalLeads, `${convertedLeads} converted · ${pct(convertedLeads, totalLeads)} conversion`),
        stat("Deals won", wonDeals.length, `Worth ${wonValue.toLocaleString()} · ${pct(wonDeals.length, closed)} win rate`),
        stat("Deals lost", lostDeals, `${newDeals} new deals created`),
        stat("Open pipeline", pipelineValue.toLocaleString(), `${openDeals.length} open deals`),
        stat("Revenue collected", `${revenue.toLocaleString()} ${currency}`, `${invoices.length} paid / partially paid invoices`),
      ],
    };
  },
};
