import { isAdmin, getTerms, resolveOwnerScope, has, matchesWord, formatDateTime, fullName, plural, noPermission } from "../helpers.js";

const WORDS = ["call", "calls", "log", "logs", "history", "missed", "failed", "completed", "phone", "whatsapp", "made", "duration", "talk", "talked"];

const formatDuration = (sec) => {
  if (!sec) return "0s";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return [h && `${h}h`, m && `${m}m`, !h && `${s}s`].filter(Boolean).join(" ");
};

export default {
  name: "call-logs",

  // "calls", "call logs", "missed calls" — but not "deal called X" or target call counts
  match: ({ lower }) =>
    matchesWord(lower, "calls|call logs?|call history|missed calls?|phone calls?|call duration|talk time") && !has(lower, "target", "zoom"),

  handle: async (ctx) => {
    const { CallLog } = ctx.models;
    if (!CallLog) return null;

    const { lower, dateFilter, dateLabel } = ctx;
    const terms = getTerms(ctx, WORDS);
    const scope = await resolveOwnerScope(ctx, terms);
    if (scope.denied) return noPermission("calls-by-salesperson", "other users' call logs");

    const query = {};
    if (scope.ids) query.userId = { $in: scope.ids };
    if (dateFilter) query.createdAt = dateFilter;

    let label = "";
    if (has(lower, "missed")) { query.callStatus = "missed"; label = "missed "; }
    else if (has(lower, "failed")) { query.callStatus = "failed"; label = "failed "; }
    else if (has(lower, "completed", "connected", "answered")) { query.callStatus = "completed"; label = "completed "; }
    if (matchesWord(lower, "whatsapp")) query.callType = "whatsapp";

    const calls = await CallLog.find(query)
      .populate("userId", "firstName lastName")
      .populate("leadId", "leadName companyName")
      .populate("dealId", "dealName companyName")
      .sort({ createdAt: -1 })
      .limit(100);

    const totalSeconds = calls.reduce((sum, c) => sum + (c.duration || 0), 0);
    const owner = scope.names ? `${scope.names} made` : isAdmin(ctx) && !scope.ids ? "Your team made" : "You made";
    let message = `${owner} ${plural(calls.length, `${label}call`)}${dateLabel}`;
    message += calls.length && !label ? ` with a total talk time of ${formatDuration(totalSeconds)}.` : ".";
    if (calls.length === 100) message += " Showing the latest 100.";

    return {
      intent: `call-logs${label ? `-${label.trim()}` : ""}`,
      message,
      data: calls.map((c) => ({
        _id: c._id,
        type: "call",
        name: c.leadId?.leadName || c.dealId?.dealName || "Unknown contact",
        status: c.callStatus,
        detail: `${formatDateTime(c.startTime || c.createdAt)} · ${c.callType === "whatsapp" ? "WhatsApp" : "Phone"} · ${formatDuration(c.duration)}`,
        companyName: c.leadId?.companyName || c.dealId?.companyName || null,
        handledBy: fullName(c.userId) || "Unknown",
        createdAt: c.createdAt,
      })),
    };
  },
};
