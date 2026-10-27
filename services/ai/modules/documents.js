import { thereAre, isAdmin, hasPermission, noPermission, getTerms, resolveOwnerScope, matchesWord, formatDate, fullName, plural, regexOf } from "../helpers.js";

const WORDS = ["document", "documents", "docs", "doc", "hub", "files", "file", "shared", "assigned", "pending", "approved", "rejected", "viewed", "replied", "review", "awaiting", "sent"];
const STATUS_WORDS = [
  ["approved", "Approved"],
  ["rejected", "Rejected"],
  ["replied", "Replied"],
  ["viewed|seen|opened", "Viewed"],
  ["pending|new|unread|awaiting|to review", "Assigned"],
];

// Document Hub (assigned documents). Lead/deal attachments ("documents of deal X") stay with the deal/lead flow.
export default {
  name: "documents",

  match: ({ lower }) => matchesWord(lower, "documents?|docs|document hub|shared files") && !matchesWord(lower, "deals?|leads?"),

  handle: async (ctx) => {
    const { DocumentAssignment, ExternalDocument } = ctx.models;
    if (!DocumentAssignment && !ExternalDocument) return null;
    if (!hasPermission(ctx, "documents")) return noPermission("documents", "Documents");

    const { lower, dateFilter, dateLabel } = ctx;
    const terms = getTerms(ctx, WORDS);
    const scope = await resolveOwnerScope(ctx, terms);
    if (scope.denied) return noPermission("documents-by-user", "other users' documents");

    const status = STATUS_WORDS.find(([pattern]) => matchesWord(lower, pattern))?.[1];
    // "documents I shared / sent" -> by assigner; otherwise documents assigned to the person
    const bySender = matchesWord(lower, "i shared|i sent|i assigned|shared by me|sent by me");

    const build = (assigneeField, senderField) => {
      const q = { deletedAt: null };
      if (scope.ids) q[bySender ? senderField : assigneeField] = { $in: scope.ids };
      if (status) q.status = status;
      if (dateFilter) q.createdAt = dateFilter;
      return q;
    };

    const term = !scope.names && terms[0];
    const assignQ = build("assignedTo", "assignedBy");
    const externalQ = build("assignedTo", "uploadedBy");
    if (term) {
      assignQ.$or = [{ documentName: regexOf(term) }, { sourceName: regexOf(term) }];
      externalQ.name = regexOf(term);
    }

    const [assignments, externals] = await Promise.all([
      DocumentAssignment
        ? DocumentAssignment.find(assignQ).populate("assignedTo", "firstName lastName").populate("assignedBy", "firstName lastName").sort({ createdAt: -1 }).limit(50)
        : [],
      ExternalDocument
        ? ExternalDocument.find(externalQ).populate("assignedTo", "firstName lastName").populate("uploadedBy", "firstName lastName").sort({ createdAt: -1 }).limit(50)
        : [],
    ]);

    const rows = [
      ...assignments.map((d) => ({
        _id: d._id,
        type: "document",
        name: d.documentName || "Document",
        status: d.status === "Assigned" ? "Pending" : d.status,
        detail: `${d.sourceType}${d.sourceName ? `: ${d.sourceName}` : ""} · from ${fullName(d.assignedBy) || "Unknown"} · ${formatDate(d.createdAt)}`,
        handledBy: fullName(d.assignedTo) || "Unassigned",
        createdAt: d.createdAt,
      })),
      ...externals.map((d) => ({
        _id: d._id,
        type: "document",
        name: d.name,
        status: d.status === "Assigned" ? "Pending" : d.status,
        detail: `External · from ${fullName(d.uploadedBy) || "Unknown"} · ${formatDate(d.createdAt)}`,
        handledBy: fullName(d.assignedTo) || "Unassigned",
        createdAt: d.createdAt,
      })),
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const statusLabel = status ? `${status === "Assigned" ? "pending" : status.toLowerCase()} ` : "";
    const owner = scope.names ? `${scope.names} has` : isAdmin(ctx) && !scope.ids ? thereAre(rows.length) : bySender ? "You shared" : "You have";
    return {
      intent: `documents${status ? `-${status.toLowerCase()}` : ""}`,
      message: `${owner} ${plural(rows.length, `${statusLabel}document`)}${term ? ` matching "${term}"` : ""}${dateLabel}.`,
      data: rows,
    };
  },
};
