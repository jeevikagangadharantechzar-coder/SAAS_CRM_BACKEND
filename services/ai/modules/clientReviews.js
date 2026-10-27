import { thereAre, isAdmin, hasPermission, noPermission, getTerms, resolveOwnerScope, has, matchesWord, formatDate, plural, regexOf } from "../helpers.js";

const WORDS = ["client", "clients", "customer", "customers", "review", "reviews", "health", "score", "scores", "excellent", "good", "average", "poor", "unhappy", "happy", "upsell", "feedback"];
const PROGRESS = [["excellent|happy", "Excellent"], ["good", "Good"], ["average", "Average"], ["poor|unhappy|bad", "Poor"]];

export default {
  name: "client-reviews",

  match: ({ lower }) => matchesWord(lower, "client reviews?|customer reviews?|reviews?|client health|health scores?|client feedback|customer feedback"),

  handle: async (ctx) => {
    const { ClientReview } = ctx.models;
    if (!ClientReview) return null;
    if (!hasPermission(ctx, "reports", "deal_analysis")) return noPermission("client-reviews", "Client Reviews");

    const { lower, dateFilter, dateLabel } = ctx;
    const terms = getTerms(ctx, WORDS);
    const scope = await resolveOwnerScope(ctx, terms);
    if (scope.denied) return noPermission("client-reviews", "other users' client reviews");

    const query = {};
    if (scope.ids) query.salespersonId = { $in: scope.ids };
    const progress = PROGRESS.find(([pattern]) => matchesWord(lower, pattern))?.[1];
    if (progress) query.progress = progress;
    if (has(lower, "upsell")) query.upsellOpportunity = true;
    if (has(lower, "low health", "low score", "at risk")) query.clientHealthScore = { $lt: 40 };
    if (dateFilter) query.reviewedAt = dateFilter;

    const term = !scope.names && terms[0];
    if (term) query.$or = [{ companyName: regexOf(term) }, { clientName: regexOf(term) }];

    const reviews = await ClientReview.find(query).sort({ clientHealthScore: query.clientHealthScore || progress === "Poor" ? 1 : -1 }).limit(50);
    const avg = reviews.length ? reviews.reduce((s, r) => s + (r.clientHealthScore || 0), 0) / reviews.length : 0;

    const owner = scope.names ? `${scope.names} has` : isAdmin(ctx) && !scope.ids ? thereAre(reviews.length) : "You have";
    const label = `${progress ? `${progress.toLowerCase()} ` : ""}client review`;
    return {
      intent: `client-reviews${progress ? `-${progress.toLowerCase()}` : ""}`,
      message: reviews.length
        ? `${owner} ${plural(reviews.length, label)}${term ? ` for "${term}"` : ""}${dateLabel} with an average health score of ${avg.toFixed(0)}/100.`
        : `No ${label}s found${term ? ` for "${term}"` : ""}${dateLabel}.`,
      data: reviews.map((r) => ({
        _id: r._id,
        type: "client_review",
        name: r.clientName,
        companyName: r.companyName,
        status: r.progress,
        value: `Health ${r.clientHealthScore}/100`,
        detail: [r.upsellOpportunity && "Upsell opportunity", r.supportTickets ? plural(r.supportTickets, "ticket") : null, `reviewed ${formatDate(r.reviewedAt)}`].filter(Boolean).join(" · "),
        handledBy: r.salespersonName || "Unassigned",
        createdAt: r.createdAt,
      })),
    };
  },
};
