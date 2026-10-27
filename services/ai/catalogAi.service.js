import { getTenantModels } from "../../models/tenant/index.js";
import { ProductService } from "../product.service.js";
import { ServiceCatalogService } from "../serviceCatalog.service.js";
import { findCategoryByName } from "./helpers.js";
const MAX_RESULTS = 50;

// Ziya's date filter is a Mongo range ({ $gte, $lte }); the catalog services take startDate/endDate.
const toDateRange = (dateFilter) =>
  dateFilter ? { startDate: dateFilter.$gte, endDate: dateFilter.$lte } : {};

export class CatalogAiService {
  /**
   * Search products, services, or both.
   * @param {object} filters { type: "Product" | "Service" | null, search, isActive, standaloneOnly, categoryId, dateFilter }
   */
  static async searchItems(tenantDB, { type = null, search, isActive, standaloneOnly = false, categoryId, dateFilter } = {}) {
    const common = { search, isActive, category: categoryId, ...toDateRange(dateFilter), limit: MAX_RESULTS, sort: "name", order: "asc" };

    const [products, services] = await Promise.all([
      type === "Service" ? { items: [] } : ProductService.listProducts(tenantDB, common),
      type === "Product" ? { items: [] } : ServiceCatalogService.listServices(tenantDB, common),
    ]);

    // listServices has no "no parent product" filter, so standalone services are filtered here.
    const serviceItems = standaloneOnly ? services.items.filter((s) => !s.parentProduct) : services.items;

    return [...products.items, ...serviceItems]
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_RESULTS);
  }

  /**
   * Catalog category by name ("IT", "AMC Plans"), or null.
   */
  static async findCategory(tenantDB, name, { activeOnly = false } = {}) {
    const { CatalogCategory } = getTenantModels(tenantDB);
    const category = await findCategoryByName(CatalogCategory, name);
    return activeOnly && category?.isActive === false ? null : category;
  }

  /**
   * All catalog categories with how many products and services each holds.
   * @param {"Product"|"Service"|null} type  only count this item type
   * @param {boolean} activeOnly  only active categories, counting only active items
   */
  static async listCategoriesWithCounts(tenantDB, type = null, { activeOnly = false } = {}) {
    const { CatalogCategory, CatalogItem } = getTenantModels(tenantDB);
    const [categories, counts] = await Promise.all([
      CatalogCategory.find(activeOnly ? { isActive: { $ne: false } } : {}).sort({ name: 1 }).lean(),
      CatalogItem.aggregate([
        { $match: { ...(type && { type }), ...(activeOnly && { isActive: true }) } },
        { $group: { _id: { category: "$category", type: "$type" }, count: { $sum: 1 } } },
      ]),
    ]);

    const tally = {};
    counts.forEach(({ _id, count }) => {
      const key = String(_id.category);
      tally[key] = tally[key] || { Product: 0, Service: 0 };
      tally[key][_id.type] = count;
    });

    return categories.map((c) => ({
      ...c,
      productCount: tally[String(c._id)]?.Product || 0,
      serviceCount: tally[String(c._id)]?.Service || 0,
    }));
  }

  /**
   * Best product match for a name or SKU, or null.
   */
  static async findProduct(tenantDB, term, { activeOnly = false } = {}) {
    const { items } = await ProductService.listProducts(tenantDB, {
      search: term, ...(activeOnly && { isActive: true }), limit: 5, sort: "name", order: "asc",
    });
    const lower = term.toLowerCase();
    // Prefer an exact name/SKU match over a partial one.
    return items.find((p) => p.name.toLowerCase() === lower || p.sku?.toLowerCase() === lower) || items[0] || null;
  }

  /**
   * Services linked to a product ("services for product X").
   * @returns {{ product: object|null, services: object[] }}
   */
  static async getLinkedServices(tenantDB, productTerm, { isActive } = {}) {
    const product = await this.findProduct(tenantDB, productTerm, { activeOnly: isActive === true });
    if (!product) return { product: null, services: [] };

    const { items } = await ServiceCatalogService.listServices(tenantDB, {
      parentProduct: product._id,
      isActive,
      limit: MAX_RESULTS,
      sort: "name",
      order: "asc",
    });
    return { product, services: items };
  }

  /**
   * Price breakdown for one item: base price, tax amount and total including tax.
   */
  static getPriceQuote(item) {
    const unitPrice = Number(item.unitPrice) || 0;
    const taxRate = Number(item.taxRate) || 0;
    const taxAmount = Math.round(unitPrice * taxRate) / 100;
    return {
      unitPrice,
      taxRate,
      taxAmount,
      totalWithTax: unitPrice + taxAmount,
      currency: item.currency || "INR",
      billingUnit: item.billingUnit || "unit",
    };
  }
}
