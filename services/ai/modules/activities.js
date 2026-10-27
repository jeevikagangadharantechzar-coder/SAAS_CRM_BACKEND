import { thereAre, isAdmin, hasPermission, noPermission, getTerms, resolveOwnerScope, has, matchesWord, formatDate, fullName } from "../helpers.js";

const WORDS = ["activity", "activities", "upcoming", "next", "overdue", "reminder", "reminders", "deadline", "deadlines", "category"];
const CATEGORIES = { call: "Call", meeting: "Meeting", email: "Email", task: "Task", deadline: "Deadline", other: "Other" };

// Deal-specific activity ("deal acme activity") is still answered by the deal details flow in ai.controller.js.
export default {
  name: "activities",

  match: ({ lower }) => matchesWord(lower, "activity|activities|deadlines?") && !matchesWord(lower, "deals?|leads?"),

  handle: async (ctx) => {
    const { Activity } = ctx.models;
    if (!Activity) return null;
    if (!hasPermission(ctx, "activities", "activities_list", "activities_calendar")) return noPermission("activities", "Activities");

    const { lower, dateFilter, dateLabel } = ctx;
    const terms = getTerms(ctx, [...WORDS, ...Object.keys(CATEGORIES)]);
    const scope = await resolveOwnerScope(ctx, terms);
    if (scope.denied) return noPermission("activities-by-salesperson", "other users' activities");

    const query = {};
    if (scope.ids) query.assignedTo = { $in: scope.ids };

    const categoryKey = Object.keys(CATEGORIES).find((k) => matchesWord(lower, `${k}s?`));
    if (categoryKey) query.activityCategory = CATEGORIES[categoryKey];

    let label = "";
    const startOfToday = new Date(new Date().setHours(0, 0, 0, 0));
    if (dateFilter) query.startDate = dateFilter;
    else if (has(lower, "overdue", "missed", "past due")) { query.endDate = { $lt: startOfToday }; label = "overdue "; }
    else { query.endDate = { $gte: startOfToday }; label = "upcoming "; }

    const activities = await Activity.find(query)
      .populate("assignedTo", "firstName lastName")
      .populate("deal", "dealName companyName")
      .sort({ startDate: label === "overdue " ? -1 : 1 })
      .limit(50);

    const kind = categoryKey ? `${CATEGORIES[categoryKey].toLowerCase()} activity` : "activity";
    const owner = scope.names ? `${scope.names} has` : isAdmin(ctx) && !scope.ids ? thereAre(activities.length) : "You have";
    const count = activities.length;
    const noun = count === 1 ? kind : kind.replace(/activity$/, "activities");

    return {
      intent: `activities-${label.trim() || "list"}`,
      message: `${owner} ${count} ${label}${noun}${dateLabel}.`,
      data: activities.map((a) => ({
        _id: a._id,
        type: "activity",
        name: a.title,
        status: a.activityCategory,
        detail: `${formatDate(a.startDate)} ${a.startTime || ""}–${a.endTime || ""}`.trim(),
        companyName: a.deal?.dealName || null,
        dealId: a.deal?._id || null,
        handledBy: fullName(a.assignedTo) || "Unassigned",
        createdAt: a.createdAt,
      })),
    };
  },
};
