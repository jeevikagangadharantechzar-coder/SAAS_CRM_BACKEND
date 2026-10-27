import { isAdmin, getTerms, findUsersByTerms, matchesWord, formatDateTime, fullName, plural } from "../helpers.js";

const WORDS = ["location", "locations", "live", "where", "located", "last", "seen", "current", "team", "everyone", "all", "field", "map"];

// Admin only: last reported location of a user (from the Live Locations feature).
export default {
  name: "user-location",

  // "where is" only counts when it isn't about a record ("where is invoice X")
  match: ({ lower }) =>
    !matchesWord(lower, "leads?|deals?|invoices?|tasks?|tickets?|meetings?|proposals?|assets?|documents?|products?|services?|files?") &&
    matchesWord(lower, "live locations?|locations?|located|where is"),

  handle: async (ctx) => {
    const { UserLocation, User } = ctx.models;
    if (!UserLocation || !User) return null;
    if (!isAdmin(ctx)) return { intent: "user-location", message: "Only admins can view team members' live locations.", data: [] };

    const terms = getTerms(ctx, WORDS);
    const matched = await findUsersByTerms(ctx, terms);
    if (terms.length && !matched.length) {
      return { intent: "user-location", message: `No user found matching "${terms[0]}".`, data: [] };
    }

    const query = matched.length ? { userId: { $in: matched.map((u) => u._id) } } : {};
    const locations = await UserLocation.find(query).populate("userId", "firstName lastName").sort({ updatedAt: -1 }).limit(50);

    let message;
    if (!locations.length) message = matched.length ? `${fullName(matched[0])} hasn't shared a location yet.` : "No team members have shared a location yet.";
    else if (matched.length === 1) message = `${fullName(locations[0].userId)} was last seen at ${formatDateTime(locations[0].updatedAt)}.`;
    else message = `${plural(locations.length, "team member")} ${locations.length === 1 ? "has" : "have"} shared a location.`;

    return {
      intent: "user-location",
      message,
      data: locations.map((l) => ({
        _id: l._id,
        type: "location",
        name: fullName(l.userId) || "Unknown user",
        detail: `Last seen ${formatDateTime(l.updatedAt)}${l.accuracy ? ` · ±${Math.round(l.accuracy)}m` : ""}`,
        link: `https://www.google.com/maps?q=${l.latitude},${l.longitude}`,
        handledBy: null,
        createdAt: l.updatedAt,
      })),
    };
  },
};
