import { thereAre, isAdmin, hasPermission, noPermission, getTerms, resolveOwnerScope, has, matchesWord, formatDate, plural, regexOf } from "../helpers.js";

const WORDS = ["pricing", "price", "risk", "risks", "risky", "discount", "discounts", "high", "medium", "low", "level", "resolved", "ignored", "active", "deal", "deals"];

// Pricing / discount risk on deals. "Clients at risk" (churn) stays with the Client LTV flow.
export default {
  name: "pricing-risk",

  match: ({ lower }) => matchesWord(lower, "pricing risks?|price risks?|discount risks?|risky deals?|high risk deals?|risk level|deals? at risk|over.?discount(ed)?"),

  handle: async (ctx) => {
    const { PricingRisk } = ctx.models;
    if (!PricingRisk) return null;
    if (!hasPermission(ctx, "reports", "deal_analysis")) return noPermission("pricing-risk", "Pricing Risk");

    const { lower, dateFilter, dateLabel } = ctx;
    const terms = getTerms(ctx, WORDS);
    const scope = await resolveOwnerScope(ctx, terms);
    if (scope.denied) return noPermission("pricing-risk", "other users' pricing risks");

    const query = {};
    if (scope.ids) query.salespersonId = { $in: scope.ids };
    const level = ["high", "medium", "low"].find((l) => matchesWord(lower, `${l} risk|${l}`));
    if (level) query.riskLevel = level[0].toUpperCase() + level.slice(1);
    if (has(lower, "resolved")) query.status = "Resolved";
    else if (has(lower, "ignored")) query.status = "Ignored";
    else query.status = "Active";
    if (dateFilter) query.detectedAt = dateFilter;

    const term = !scope.names && terms[0];
    if (term) query.$or = [{ companyName: regexOf(term) }, { dealName: regexOf(term) }];

    const order = { High: 0, Medium: 1, Low: 2 };
    const risks = (await PricingRisk.find(query).sort({ detectedAt: -1 }).limit(50))
      .sort((a, b) => (order[a.riskLevel] ?? 3) - (order[b.riskLevel] ?? 3));
    const atStake = risks.reduce((s, r) => s + (Number(r.dealValue) || 0), 0);

    const owner = scope.names ? `${scope.names} has` : isAdmin(ctx) && !scope.ids ? thereAre(risks.length) : "You have";
    const label = `${query.status.toLowerCase()} ${level ? `${level}-risk ` : ""}pricing alert`;
    return {
      intent: `pricing-risk${level ? `-${level}` : ""}`,
      message: risks.length
        ? `${owner} ${plural(risks.length, label)}${dateLabel} on deals worth ${atStake.toLocaleString()}.`
        : `No ${label}s found${dateLabel}.`,
      data: risks.map((r) => ({
        _id: r.dealId,
        type: "deal",
        name: r.dealName,
        companyName: r.companyName,
        status: `${r.riskLevel} risk`,
        value: String(r.dealValue),
        lossReason: r.riskFactors?.length ? r.riskFactors.join(", ") : null,
        detail: `Discount ${r.discountGiven || 0}% (recommended ${r.recommendedDiscount || 0}%) · detected ${formatDate(r.detectedAt)}`,
        handledBy: r.salespersonName || "Unassigned",
        createdAt: r.createdAt,
      })),
    };
  },
};
