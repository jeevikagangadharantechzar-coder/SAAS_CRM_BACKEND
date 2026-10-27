import { CatalogAiService } from "../../services/ai/catalogAi.service.js";
import { isAdmin, hasPermission, noPermission, getTerms, has, matchesWord, plural, extractCategory } from "../../services/ai/helpers.js";

/**
 * Ziya chatbot — Products & Services.
 * Controller layer: works out what the user asked (product vs service, filters,
 * price question, linked services), checks permission, calls CatalogAiService
 * and shapes the chat reply. No DB access here.
 *
 * Deal line items ("products in deal X") stay with the deal flow in ai.controller.js.
 */

const WORDS = [
  "product", "products", "service", "services", "catalog", "catalogue", "item", "items", "sku", "price", "prices", "pricing",
  "cost", "costs", "much", "rate", "active", "inactive", "linked", "standalone", "category", "categories", "amc", "available", "all",
];

const formatMoney = (amount, currency = "INR") => {
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 2 }).format(amount || 0);
  } catch {
    return `${currency} ${Number(amount || 0).toLocaleString()}`;
  }
};

// Turns the message into service filters.
const parseQuestion = (ctx) => {
  const { lower } = ctx;
  const mentionsService = matchesWord(lower, "services?|amc");
  const mentionsProduct = matchesWord(lower, "products?");
  const type = mentionsService && !mentionsProduct ? "Service" : mentionsProduct && !mentionsService ? "Product" : null;

  let isActive;
  if (matchesWord(lower, "inactive|disabled")) isActive = false;
  else if (matchesWord(lower, "active|available")) isActive = true;

  // "products in IT category" / "what categories are there". Only the item-type words are
  // ignored here — a category can be named after other keywords ("AMC", "Active Plans").
  const category = extractCategory(lower, ["product", "products", "service", "services", "catalog", "catalogue", "item", "items"]);

  // "services for product X" / "services linked to X" (not "services for IT category")
  const linkedMatch = !category && lower.match(/services?\s+(?:for|of|linked to|under)\s+(?:product\s+)?(.+)$/);

  // Words of the category name aren't also a name/SKU search.
  const categoryWords = category?.name ? category.name.split(" ") : [];

  return {
    type,
    isActive,
    category,
    standaloneOnly: type === "Service" && has(lower, "standalone"),
    linkedProductTerm: linkedMatch ? linkedMatch[1].trim() : null,
    search: getTerms(ctx, WORDS).filter((w) => !categoryWords.includes(w)).join(" "),
    isPriceQuestion: has(lower, "price", "cost", "rate", "how much"),
  };
};

const categoryListReply = async (ctx, q) => {
  const categories = await CatalogAiService.listCategoriesWithCounts(ctx.req.tenantDB, q.type, { activeOnly: q.activeOnlyView });
  const what = q.type ? `${q.type.toLowerCase()} ` : "";
  return {
    intent: "catalog-categories",
    message: categories.length
      ? `There ${categories.length === 1 ? "is 1" : `are ${categories.length}`} ${what}${categories.length === 1 ? "category" : "categories"}: ${categories.map((c) => c.name).join(", ")}.`
      : "No catalog categories have been created yet.",
    data: categories.map((c) => ({
      _id: c._id,
      type: "catalog_category",
      itemType: q.type,
      name: `${c.icon ? `${c.icon} ` : ""}${c.name}`,
      status: c.isActive === false ? "Inactive" : "Active",
      detail: [q.type !== "Service" && plural(c.productCount, "product"), q.type !== "Product" && plural(c.serviceCount, "service")].filter(Boolean).join(" · "),
      handledBy: null,
      createdAt: c.createdAt,
    })),
  };
};

const toCard = (item) => ({
  _id: item._id,
  type: "catalog_item",
  itemType: item.type,
  name: `${item.name}${item.sku ? ` (${item.sku})` : ""}`,
  status: item.isActive === false ? "Inactive" : "Active",
  value: `${formatMoney(item.unitPrice, item.currency)} / ${item.billingUnit || "unit"}`,
  detail: [
    item.type,
    item.categoryName,
    item.type === "Service" ? (item.parentProductName ? `for ${item.parentProductName}` : "Standalone") : null,
    item.type === "Service" ? item.serviceType : null,
  ].filter(Boolean).join(" · "),
  handledBy: null,
  createdAt: item.createdAt,
});

const linkedServicesReply = async (ctx, q) => {
  const { product, services } = await CatalogAiService.getLinkedServices(ctx.req.tenantDB, q.linkedProductTerm, { isActive: q.isActive });
  if (!product) {
    return { intent: "catalog-linked-services", message: `No product found matching "${q.linkedProductTerm}".`, data: [] };
  }
  return {
    intent: "catalog-linked-services",
    message: `"${product.name}" has ${plural(services.length, `${q.isActive === false ? "inactive " : ""}linked service`)}.`,
    data: services.map(toCard),
  };
};

const priceReply = (item) => {
  const p = CatalogAiService.getPriceQuote(item);
  const tax = p.taxRate ? ` + ${p.taxRate}% tax (${formatMoney(p.totalWithTax, p.currency)} incl. tax)` : "";
  return {
    intent: `catalog-price`,
    message: `${item.name} costs ${formatMoney(p.unitPrice, p.currency)} per ${p.billingUnit}${tax}.`,
    data: [toCard(item)],
  };
};

export default {
  name: "catalog",

  // Bare "categories" questions belong here unless they're about assets.
  match: ({ lower }) =>
    (matchesWord(lower, "products?|services?|catalog|catalogue|sku") ||
      (matchesWord(lower, "categor(?:y|ies)") && !matchesWord(lower, "assets?|equipment|inventory"))) &&
    !matchesWord(lower, "deals?|leads?|tickets?"),

  handle: async (ctx) => {
    if (!ctx.req.tenantDB) return null;
    if (!hasPermission(ctx, "products_services")) return noPermission("catalog", "Products & Services");

    const q = parseQuestion(ctx);

    // Only admins see inactive items and categories; everyone else gets what can actually be sold.
    q.activeOnlyView = !isAdmin(ctx);
    if (q.activeOnlyView) {
      if (q.isActive === false) {
        return { intent: "catalog-inactive-restricted", message: "Inactive products and services are only visible to admins.", data: [] };
      }
      q.isActive = true;
    }

    if (q.category?.listOnly) return categoryListReply(ctx, q);
    if (q.linkedProductTerm) return linkedServicesReply(ctx, q);

    let category = null;
    if (q.category?.name) {
      category = await CatalogAiService.findCategory(ctx.req.tenantDB, q.category.name, { activeOnly: q.activeOnlyView });
      if (!category) {
        const reply = await categoryListReply(ctx, q);
        const available = reply.data.length ? ` Available categories: ${reply.data.map((c) => c.name).join(", ")}.` : "";
        return { ...reply, intent: "catalog-category-not-found", message: `No catalog category named "${q.category.name}".${available}` };
      }
    }

    const items = await CatalogAiService.searchItems(ctx.req.tenantDB, { ...q, categoryId: category?._id, dateFilter: ctx.dateFilter });
    if (q.search && q.isPriceQuestion && items.length === 1) return priceReply(items[0]);

    // Non-admins always get active items, so "active" only appears when they asked for it.
    const askedActive = matchesWord(ctx.lower, "active|available");
    const stateLabel = q.isActive === false ? "inactive " : q.isActive === true && (askedActive || !q.activeOnlyView) ? "active " : "";
    const typeLabel = q.type ? q.type.toLowerCase() : "catalog item";
    const standaloneLabel = q.standaloneOnly ? "standalone " : "";
    const inCategory = category ? ` in the "${category.name}" category` : "";

    return {
      intent: `catalog-${q.type ? q.type.toLowerCase() : "items"}${category ? "-by-category" : ""}`,
      message: `Found ${plural(items.length, `${stateLabel}${standaloneLabel}${typeLabel}`)}${inCategory}${q.search ? ` matching "${q.search}"` : ""}${ctx.dateLabel}.`,
      data: items.map(toCard),
    };
  },
};
