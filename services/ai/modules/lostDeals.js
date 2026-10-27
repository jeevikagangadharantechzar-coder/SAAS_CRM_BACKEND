import { isAdmin, hasPermission, noPermission, getTerms, resolveOwnerScope, has, matchesWord, formatDate, fullName, plural } from "../helpers.js";

const WORDS = ["lost", "loss", "losing", "deal", "deals", "reason", "reasons", "why", "top", "main", "most", "common", "breakdown", "biggest"];

// Breakdown of why deals were lost (LostDealReason records). A plain "lost deals" list stays with the deal flow.
export default {
  name: "lost-deal-reasons",

  match: ({ lower }) =>
    matchesWord(lower, "deals?") && matchesWord(lower, "lost|loss|losing") &&
    has(lower, "reason", "why", "breakdown") && !matchesWord(lower, "leads?"),

  handle: async (ctx) => {
    const { LostDealReason, Deal } = ctx.models;
    if (!LostDealReason) return null;
    if (!hasPermission(ctx, "loss_analysis")) return noPermission("lost-deal-reasons", "Loss Analysis");

    const { dateFilter, dateLabel } = ctx;
    const terms = getTerms(ctx, WORDS);
    const scope = await resolveOwnerScope(ctx, terms);
    if (scope.denied) return noPermission("lost-deal-reasons", "other users' lost deals");

    const query = {};
    if (scope.ids && Deal) {
      const deals = await Deal.find({ assignedTo: { $in: scope.ids } }).select("_id");
      query.dealId = { $in: deals.map((d) => d._id) };
    }
    if (dateFilter) query.createdAt = dateFilter;

    const records = await LostDealReason.find(query)
      .populate({ path: "dealId", select: "dealName companyName value assignedTo", populate: { path: "assignedTo", select: "firstName lastName" } })
      .sort({ createdAt: -1 })
      .limit(200);

    if (!records.length) {
      return { intent: "lost-deal-reasons", message: `No lost deal reasons recorded${dateLabel}.`, data: [] };
    }

    const counts = {};
    records.forEach((r) => { counts[r.reason] = (counts[r.reason] || 0) + 1; });
    const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const [topReason, topCount] = ranked[0];
    const breakdown = ranked.slice(0, 5).map(([r, n]) => `${r} (${n})`).join(", ");
    const who = scope.names ? `${scope.names}'s ` : isAdmin(ctx) && !scope.ids ? "" : "your ";

    return {
      intent: "lost-deal-reasons",
      message: `Across ${who}${plural(records.length, "lost deal")}${dateLabel}, the top reason is "${topReason}" (${topCount}, ${((topCount / records.length) * 100).toFixed(0)}%). Breakdown: ${breakdown}.`,
      data: records.map((r) => ({
        _id: r.dealId?._id || r._id,
        type: r.dealId ? "deal" : "lost_reason",
        name: r.dealId?.dealName || "Deleted deal",
        status: "Closed Lost",
        companyName: r.dealId?.companyName || null,
        value: r.dealId?.value ? String(r.dealId.value) : null,
        lossReason: r.reason,
        lossNotes: r.notes || null,
        detail: `Lost on ${formatDate(r.createdAt)}`,
        handledBy: fullName(r.dealId?.assignedTo) || "Unassigned",
        createdAt: r.createdAt,
      })),
    };
  },
};
