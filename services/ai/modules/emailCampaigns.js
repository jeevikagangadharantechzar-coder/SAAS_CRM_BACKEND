import { thereAre, isAdmin, hasPermission, noPermission, getTerms, resolveOwnerScope, has, matchesWord, formatDateTime, fullName, plural, regexOf } from "../helpers.js";

const WORDS = ["email", "emails", "mail", "mails", "campaign", "campaigns", "mass", "bulk", "newsletter", "template", "templates", "scheduled", "sent", "failed", "cancelled", "pending", "last", "latest", "recent"];
const STATUS_WORDS = [
  ["scheduled|upcoming", "scheduled"],
  ["failed|bounced", "failed"],
  ["cancelled|canceled", "cancelled"],
  ["sent|delivered", "sent"],
  ["pending|queued", "pending"],
];

// Mass email campaigns and email templates. Deal/lead email threads stay with their own flows.
export default {
  name: "email-campaigns",

  match: ({ lower }) =>
    matchesWord(lower, "emails?|mails?|campaigns?|mass emails?|bulk emails?|newsletters?|email templates?") &&
    !matchesWord(lower, "deals?|leads?|my email|email address|email id"),

  handle: async (ctx) => {
    const { MassEmail, EmailTemplate } = ctx.models;
    if (!MassEmail) return null;
    if (!hasPermission(ctx, "email_campaigns")) return noPermission("email-campaigns", "Email Campaigns");

    const { lower, dateFilter, dateLabel } = ctx;
    const terms = getTerms(ctx, WORDS);

    if (EmailTemplate && matchesWord(lower, "templates?")) {
      const term = terms[0];
      const templates = await EmailTemplate.find(term ? { $or: [{ title: regexOf(term) }, { subject: regexOf(term) }] } : {})
        .populate("createdBy", "firstName lastName")
        .sort({ updatedAt: -1 })
        .limit(50);
      return {
        intent: "email-templates",
        message: `There ${templates.length === 1 ? "is" : "are"} ${plural(templates.length, "email template")}${term ? ` matching "${term}"` : ""}.`,
        data: templates.map((t) => ({
          _id: t._id,
          type: "email_template",
          name: t.title,
          detail: `Subject: ${t.subject}`,
          handledBy: fullName(t.createdBy) || "System",
          createdAt: t.createdAt,
        })),
      };
    }

    const scope = await resolveOwnerScope(ctx, terms);
    if (scope.denied) return noPermission("email-campaigns", "other users' campaigns");

    const query = {};
    if (scope.ids) query.createdBy = { $in: scope.ids };
    const status = STATUS_WORDS.find(([pattern]) => matchesWord(lower, pattern))?.[1];
    if (status) query.status = status;
    if (dateFilter) query[status === "scheduled" ? "scheduledFor" : "createdAt"] = dateFilter;
    else if (status === "scheduled") query.scheduledFor = { $gte: new Date() };

    const term = !scope.names && terms[0];
    if (term) query.$or = [{ subject: regexOf(term) }, { templateTitle: regexOf(term) }];

    const latestOnly = has(lower, "last campaign", "latest campaign", "last email", "latest email", "recent campaign");
    const emails = await MassEmail.find(query)
      .populate("createdBy", "firstName lastName")
      .sort(status === "scheduled" ? { scheduledFor: 1 } : { createdAt: -1 })
      .limit(latestOnly ? 1 : 50);

    const recipients = emails.reduce((s, e) => s + (e.recipients?.length || 0), 0);
    const owner = scope.names ? `${scope.names} has` : isAdmin(ctx) && !scope.ids ? thereAre(emails.length) : "You have";
    let message;
    if (latestOnly && emails[0]) {
      const e = emails[0];
      message = `The latest campaign is "${e.subject}" (${e.status}) sent to ${plural(e.recipients?.length || 0, "recipient")} on ${formatDateTime(e.scheduledFor || e.createdAt)}.`;
    } else {
      message = `${owner} ${plural(emails.length, `${status ? `${status} ` : ""}email campaign`)}${dateLabel}${emails.length ? ` reaching ${plural(recipients, "recipient")}` : ""}.`;
    }

    return {
      intent: `email-campaigns${status ? `-${status}` : ""}`,
      message,
      data: emails.map((e) => ({
        _id: e._id,
        type: "email_campaign",
        name: e.subject,
        status: e.status,
        detail: `${plural(e.recipients?.length || 0, "recipient")} · ${e.scheduledFor ? `scheduled ${formatDateTime(e.scheduledFor)}` : formatDateTime(e.createdAt)}`,
        handledBy: fullName(e.createdBy) || "Unknown",
        createdAt: e.createdAt,
      })),
    };
  },
};
