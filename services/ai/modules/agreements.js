import { isAdmin, getTerms, findUsersByTerms, has, matchesWord, formatDateTime, fullName, plural } from "../helpers.js";

const WORDS = ["agreement", "agreements", "terms", "conditions", "privacy", "policy", "accepted", "accept", "signed", "consent", "who", "pending", "not"];
const TYPES = { privacy_policy: "Privacy Policy", terms_conditions: "Terms & Conditions" };

// Privacy Policy / Terms & Conditions acceptance records.
export default {
  name: "agreements",

  match: ({ lower }) => matchesWord(lower, "agreements?|terms and conditions|terms & conditions|privacy policy|terms of service|consent"),

  handle: async (ctx) => {
    const { UserAgreement, User } = ctx.models;
    if (!UserAgreement) return null;

    const { lower } = ctx;
    const type = has(lower, "privacy") ? "privacy_policy" : has(lower, "terms") ? "terms_conditions" : null;
    const typeFilter = type ? { agreementType: type } : {};
    const matched = isAdmin(ctx) ? await findUsersByTerms(ctx, getTerms(ctx, WORDS)) : [];
    const teamWide = isAdmin(ctx) && (matched.length > 0 || matchesWord(lower, "who|users|team|everyone|all|pending|not accepted"));

    if (!teamWide) {
      const records = await UserAgreement.find({ user: ctx.userId, ...typeFilter }).sort({ acceptedAt: -1 });
      const accepted = new Set(records.map((r) => r.agreementType));
      const missing = Object.keys(type ? { [type]: 1 } : TYPES).filter((t) => !accepted.has(t));
      return {
        intent: "agreements-mine",
        message: missing.length
          ? `You haven't accepted the ${missing.map((t) => TYPES[t]).join(" and ")} yet.`
          : `You have accepted the ${[...accepted].map((t) => TYPES[t]).join(" and ")}.`,
        data: records.map((r) => ({
          _id: r._id, type: "agreement", name: TYPES[r.agreementType], status: "Accepted",
          detail: `Accepted ${formatDateTime(r.acceptedAt)}`, handledBy: null, createdAt: r.createdAt,
        })),
      };
    }

    // Admin: who hasn't accepted yet (default), or acceptance records for named users.
    if (!matched.length && User) {
      const types = type ? [type] : Object.keys(TYPES);
      const users = await User.find({}).select("firstName lastName email").lean();
      const records = await UserAgreement.find({ agreementType: { $in: types } }).select("user agreementType").lean();
      const acceptedBy = new Set(records.map((r) => `${r.user}:${r.agreementType}`));
      const pending = users
        .map((u) => ({ u, missing: types.filter((t) => !acceptedBy.has(`${u._id}:${t}`)) }))
        .filter((p) => p.missing.length);
      return {
        intent: "agreements-pending",
        message: pending.length
          ? `${plural(pending.length, "user")} ${pending.length === 1 ? "hasn't" : "haven't"} accepted ${type ? `the ${TYPES[type]}` : "all agreements"} yet.`
          : `Everyone has accepted ${type ? `the ${TYPES[type]}` : "all agreements"}.`,
        data: pending.map(({ u, missing }) => ({
          _id: u._id, type: "agreement", name: fullName(u), status: "Pending",
          detail: `Not accepted: ${missing.map((t) => TYPES[t]).join(", ")}`, handledBy: null,
        })),
      };
    }

    const records = await UserAgreement.find({ user: { $in: matched.map((u) => u._id) }, ...typeFilter })
      .populate("user", "firstName lastName")
      .sort({ acceptedAt: -1 });
    return {
      intent: "agreements-by-user",
      message: `${matched.map(fullName).join(", ")} ${records.length ? `accepted ${plural(records.length, "agreement")}` : "hasn't accepted any agreements yet"}.`,
      data: records.map((r) => ({
        _id: r._id, type: "agreement", name: `${fullName(r.user)} · ${TYPES[r.agreementType]}`, status: "Accepted",
        detail: `Accepted ${formatDateTime(r.acceptedAt)}${r.ipAddress ? ` · IP ${r.ipAddress}` : ""}`, handledBy: null, createdAt: r.createdAt,
      })),
    };
  },
};
