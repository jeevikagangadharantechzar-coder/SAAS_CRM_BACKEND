export const isAdmin = (ctx) => ctx.roleName === "Admin";

// Same rule as requirePermission() in auth.middleware.js: Admin always passes,
// everyone else needs at least one of the given role permission flags.
export const hasPermission = (ctx, ...keys) => {
  if (isAdmin(ctx) || String(ctx.roleName).toLowerCase() === "admin") return true;
  const permissions = ctx.req.user?.role?.permissions || {};
  return keys.some((key) => permissions[key]);
};

export const noPermission = (intent, moduleLabel) => ({
  intent,
  message: `Your role does not have access to ${moduleLabel}.`,
  data: [],
});

export const fullName = (u) =>
  u && (u.firstName || u.lastName) ? `${u.firstName || ""} ${u.lastName || ""}`.trim() : null;

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const regexOf = (term, anchored = false) => ({
  $regex: anchored ? `^${escapeRegex(term)}` : escapeRegex(term),
  $options: "i",
});

// Filler words the controller's stop list doesn't cover; without this they'd be read as names ("to" -> "Tom").
const EXTRA_STOP = ["i", "to", "me", "my", "did", "made", "make", "much", "many", "any", "all", "there", "have", "has", "not", "yet", "and", "or", "our", "your", "mine", "us", "also", "only", "currently", "now", "right", "in", "under", "from", "of", "for", "within", "the", "with"];

// Search terms left after removing the shared stop words and this module's own keywords.
export const getTerms = (ctx, moduleWords = []) =>
  ctx.getSearchTerms(ctx.lower).filter((w) => !moduleWords.includes(w) && !EXTRA_STOP.includes(w) && w.length > 1);

export const thereAre = (n) => (n === 1 ? "There is" : "There are");

const CATEGORY_FILLER = new Set([
  "what", "which", "are", "is", "the", "a", "an", "all", "my", "show", "list", "get", "find", "me", "available",
  "there", "do", "we", "have", "our", "of", "in", "under", "from", "for", "any", "each", "every", "by", "with",
]);

/**
 * Reads a category from the raw message (not the stop-word-filtered terms, so a category
 * like "IT" survives). Handles "products in IT category", "IT category services",
 * "category Laptops", "under the AMC Plans category".
 * @returns null when no category is mentioned, { name } for a specific one,
 *          or { name: null, listOnly: true } for "what categories are there".
 */
export const extractCategory = (lower, moduleWords = []) => {
  if (!/\bcategor(?:y|ies)\b/.test(lower)) return null;
  const patterns = [
    /\b(?:in|under|from|of|for|within)\s+(?:the\s+)?(.+?)\s+categor(?:y|ies)\b/,
    /\bcategor(?:y|ies)\s+(?:is\s+|named\s+|called\s+|=\s*|:\s*)?(.+?)(?:\s+(?:today|yesterday|this|last|added|created)\b|$)/,
    /^(.+?)\s+categor(?:y|ies)\b/,
  ];
  for (const pattern of patterns) {
    const captured = lower.match(pattern)?.[1];
    if (!captured) continue;
    const name = captured
      .split(/\s+/)
      .filter((w) => w && !CATEGORY_FILLER.has(w) && !moduleWords.includes(w))
      .join(" ")
      .trim();
    if (name) return { name, listOnly: false };
  }
  return { name: null, listOnly: true };
};

// Exact (case-insensitive) category name first, then a partial match.
export const findCategoryByName = async (Model, name) => {
  if (!Model || !name) return null;
  const exact = await Model.findOne({ name: { $regex: `^${escapeRegex(name)}$`, $options: "i" } });
  return exact || Model.findOne({ name: regexOf(name) });
};

// Users whose first or last name starts with one of the terms (first term that matches wins).
export const findUsersByTerms = async (ctx, terms) => {
  const { User } = ctx.models;
  if (!User) return [];
  for (const term of terms) {
    const users = await User.find({
      $or: [{ firstName: regexOf(term, true) }, { lastName: regexOf(term, true) }],
    }).select("_id firstName lastName email");
    if (users.length > 0) return users;
  }
  return [];
};

// Non-admins only ever see their own records. When an admin names a salesperson,
// scope to that person instead. Returns { ids, names, denied }.
export const resolveOwnerScope = async (ctx, terms) => {
  const matched = await findUsersByTerms(ctx, terms);
  const isSelf = matched.some((u) => String(u._id) === String(ctx.userId));

  if (!isAdmin(ctx)) {
    if (matched.length > 0 && !isSelf) return { ids: [ctx.userId], names: null, denied: true };
    return { ids: [ctx.userId], names: null, denied: false };
  }
  if (/\b(my|me|i|mine)\b/.test(ctx.lower) && !matched.length) return { ids: [ctx.userId], names: null, denied: false };
  if (matched.length > 0) {
    return { ids: matched.map((u) => u._id), names: matched.map(fullName).join(", "), denied: false };
  }
  return { ids: null, names: null, denied: false };
};

export const has = (lower, ...words) => words.some((w) => lower.includes(w));

export const matchesWord = (lower, pattern) => new RegExp(`\\b(${pattern})\\b`, "i").test(lower);

export const formatDateTime = (d) =>
  d ? new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : null;

export const formatDate = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { dateStyle: "medium" }) : null);

export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
