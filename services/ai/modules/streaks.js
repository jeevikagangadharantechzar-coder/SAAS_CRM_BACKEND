import { hasPermission, noPermission, getTerms, findUsersByTerms, matchesWord, fullName, plural, formatDate } from "../helpers.js";

const WORDS = ["streak", "streaks", "login", "logins", "productive", "days", "day", "longest", "current", "best"];

export default {
  name: "streaks",

  match: ({ lower }) => matchesWord(lower, "streaks?|login streak|productive days"),

  handle: async (ctx) => {
    const { Streak } = ctx.models;
    if (!Streak) return null;

    const terms = getTerms(ctx, WORDS);
    const matched = await findUsersByTerms(ctx, terms);
    const others = matched.filter((u) => String(u._id) !== String(ctx.userId));
    const teamWide = !others.length && !matchesWord(ctx.lower, "my|i") && matchesWord(ctx.lower, "team|everyone|all users|all|top|longest|highest");

    // Other people's streaks are leaderboard data.
    if ((others.length || teamWide) && !hasPermission(ctx, "streak_leaderboard")) {
      return noPermission("streaks", "the Streak Leaderboard");
    }

    const query = others.length ? { userId: { $in: others.map((u) => u._id) } } : teamWide ? {} : { userId: ctx.userId };
    const streaks = await Streak.find(query)
      .populate("userId", "firstName lastName email")
      .sort({ currentStreak: -1, longestStreak: -1 })
      .limit(teamWide ? 10 : 20);

    if (!streaks.length) {
      return { intent: "streaks", message: others.length || teamWide ? "No streak data found." : "You don't have a streak yet. Log in daily to start one!", data: [] };
    }

    let message;
    const s = streaks[0];
    if (!others.length && !teamWide) {
      message = `Your current streak is ${plural(s.currentStreak, "day")} (longest: ${plural(s.longestStreak, "day")}, ${plural(s.productiveDays, "productive day")}).`;
    } else if (others.length === 1) {
      message = `${fullName(s.userId)}'s current streak is ${plural(s.currentStreak, "day")} (longest: ${plural(s.longestStreak, "day")}).`;
    } else {
      message = `${fullName(s.userId) || "Top user"} has the longest active streak at ${plural(s.currentStreak, "day")}.`;
    }

    return {
      intent: others.length || teamWide ? "streaks-team" : "streaks",
      message,
      data: streaks.map((st) => ({
        _id: st.userId?._id || st._id,
        type: "streak",
        name: fullName(st.userId) || "Unknown user",
        status: st.performanceMetrics?.status || null,
        value: `🔥 ${plural(st.currentStreak, "day")}`,
        detail: `Longest ${plural(st.longestStreak, "day")} · ${plural(st.productiveDays, "productive day")} · last login ${formatDate(st.lastLoginDate)}`,
        handledBy: null,
        createdAt: st.createdAt,
      })),
    };
  },
};
