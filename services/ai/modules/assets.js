import { thereAre, isAdmin, hasPermission, noPermission, getTerms, resolveOwnerScope, matchesWord, fullName, plural, regexOf, extractCategory, findCategoryByName } from "../helpers.js";

const WORDS = ["asset", "assets", "equipment", "inventory", "stock", "assigned", "available", "use", "maintenance", "retired", "repair", "free", "unassigned", "category", "categories", "value", "worth"];

// "what asset categories are there" — each category with how many assets it holds (that the user can see).
const categoryList = async (ctx, ownerFilter) => {
  const { Asset, AssetCategory } = ctx.models;
  const [categories, counts] = await Promise.all([
    AssetCategory.find({}).sort({ name: 1 }),
    Asset.aggregate([{ $match: ownerFilter }, { $group: { _id: "$category", count: { $sum: 1 }, value: { $sum: { $ifNull: ["$value", 0] } } } }]),
  ]);
  const byId = Object.fromEntries(counts.map((c) => [String(c._id), c]));
  return categories.map((c) => ({
    _id: c._id,
    type: "asset_category",
    name: `${c.icon ? `${c.icon} ` : ""}${c.name}`,
    detail: `${plural(byId[String(c._id)]?.count || 0, "asset")}${byId[String(c._id)]?.value ? ` · worth ${byId[String(c._id)].value.toLocaleString()}` : ""}`,
    handledBy: null,
    createdAt: c.createdAt,
  }));
};
const STATUS_WORDS = [
  ["in stock|available|unassigned|free", "In stock"],
  ["under maintenance|maintenance|repair", "Under maintenance"],
  ["retired|disposed", "Retired"],
  ["in use", "In use"],
];

export default {
  name: "assets",

  match: ({ lower }) => matchesWord(lower, "assets?|equipment|inventory"),

  handle: async (ctx) => {
    const { Asset, AssetCategory } = ctx.models;
    if (!Asset) return null;
    if (!hasPermission(ctx, "assets")) return noPermission("assets", "Assets");

    const { lower, dateFilter, dateLabel } = ctx;
    // Category from the raw message, so names like "IT" aren't lost to stop words.
    const categoryAsk = AssetCategory ? extractCategory(lower, ["asset", "assets", "equipment", "inventory", "available", "assigned"]) : null;
    const categoryWords = categoryAsk?.name ? categoryAsk.name.split(" ") : [];

    // Category words aren't a person's name or an asset-name search.
    const terms = getTerms(ctx, WORDS).filter((t) => !categoryWords.includes(t));
    const scope = await resolveOwnerScope(ctx, terms);
    if (scope.denied) return noPermission("assets-by-user", "other users' assets");

    const query = {};
    // Non-admins see what is assigned to them; "available" assets are visible to anyone with the Assets permission.
    const status = STATUS_WORDS.find(([pattern]) => matchesWord(lower, pattern))?.[1];
    if (status) query.status = status;
    if (scope.ids && status !== "In stock") query.assignedTo = { $in: scope.ids };
    else if (matchesWord(lower, "assigned") && !status) query.assignedTo = { $ne: null };
    if (dateFilter) query.createdAt = dateFilter;

    if (categoryAsk?.listOnly) {
      const rows = await categoryList(ctx, scope.ids ? { assignedTo: { $in: scope.ids } } : {});
      return {
        intent: "asset-categories",
        message: rows.length
          ? `There ${rows.length === 1 ? "is 1 asset category" : `are ${rows.length} asset categories`}: ${rows.map((r) => r.name).join(", ")}.`
          : "No asset categories have been created yet.",
        data: rows,
      };
    }

    let category = null;
    if (categoryAsk?.name) {
      category = await findCategoryByName(AssetCategory, categoryAsk.name);
      if (!category) {
        const names = (await AssetCategory.find({}).select("name").sort({ name: 1 })).map((c) => c.name);
        return {
          intent: "asset-category-not-found",
          message: `No asset category named "${categoryAsk.name}".${names.length ? ` Available categories: ${names.join(", ")}.` : ""}`,
          data: [],
        };
      }
      query.category = category._id;
    }

    const term = !scope.names && terms[0];
    if (term) {
      // Without an explicit "category" phrase, a single word can still be a category name ("laptop assets").
      const categories = !category ? await AssetCategory?.find({ name: regexOf(term) }).select("_id") || [] : [];
      query.$or = [{ name: regexOf(term) }, { notes: regexOf(term) }, ...(categories.length ? [{ category: { $in: categories.map((c) => c._id) } }] : [])];
    }

    const assets = await Asset.find(query)
      .populate("category", "name icon")
      .populate("assignedTo", "firstName lastName")
      .sort({ updatedAt: -1 })
      .limit(50);

    const total = assets.reduce((s, a) => s + (Number(a.value) || 0), 0);
    const owner = scope.names ? `${scope.names} has` : scope.ids && status !== "In stock" ? "You have" : thereAre(assets.length);
    const inCategory = category ? ` in the "${category.name}" category` : "";
    let message = `${owner} ${plural(assets.length, `${status ? `${status.toLowerCase()} ` : ""}asset`)}${inCategory}${term ? ` matching "${term}"` : ""}${dateLabel}`;
    message += total ? ` worth ${total.toLocaleString()}.` : ".";

    return {
      intent: `assets${status ? `-${status.toLowerCase().replace(/\s+/g, "-")}` : ""}${category ? "-by-category" : ""}`,
      message,
      data: assets.map((a) => ({
        _id: a._id,
        type: "asset",
        name: `${a.category?.icon ? `${a.category.icon} ` : ""}${a.name}`,
        status: a.status,
        detail: a.category?.name || null,
        value: a.value ? Number(a.value).toLocaleString() : null,
        handledBy: fullName(a.assignedTo) || (isAdmin(ctx) ? "Not assigned" : null),
        createdAt: a.createdAt,
      })),
    };
  },
};
