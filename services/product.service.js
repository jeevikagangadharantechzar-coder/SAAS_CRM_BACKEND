import { getTenantModels } from "../models/tenant/index.js";
import { BILLING_UNITS } from "../models/schemas/catalogItemSchema.js";

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * ProductService: Dedicated Business Logic & DB queries exclusively for Physical Products
 */
export class ProductService {
  /**
   * List paginated physical products with search, category filtering, and count
   */
  static async listProducts(tenantDB, {
    page = 1,
    limit = 20,
    search,
    category,
    isActive,
    startDate,
    endDate,
    sort = "createdAt",
    order = "desc",
  }) {
    const { CatalogItem } = getTenantModels(tenantDB);
    const query = { type: "Product" };

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }

    if (search && search.trim()) {
      const searchRegex = escapeRegex(search.trim());
      query.$or = [
        { name: { $regex: searchRegex, $options: "i" } },
        { sku: { $regex: searchRegex, $options: "i" } },
        { description: { $regex: searchRegex, $options: "i" } },
        { categoryName: { $regex: searchRegex, $options: "i" } },
      ];
    }

    if (category) {
      query.category = category;
    }

    if (isActive !== undefined && isActive !== "") {
      query.isActive = isActive === "true" || isActive === true;
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 500);
    const skip = (pageNum - 1) * limitNum;

    const sortOrder = order === "asc" ? 1 : -1;
    const sortField = ["name", "sku", "unitPrice", "createdAt"].includes(sort)
      ? sort
      : "createdAt";

    const [items, total] = await Promise.all([
      CatalogItem.find(query)
        .populate("category", "name color icon")
        .populate("createdBy", "firstName lastName email")
        .populate("updatedBy", "firstName lastName email")
        .sort({ [sortField]: sortOrder })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      CatalogItem.countDocuments(query),
    ]);

    return {
      items,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum) || 1,
      },
    };
  }

  /**
   * Get single product by ID
   */
  static async getProductById(tenantDB, id) {
    const { CatalogItem } = getTenantModels(tenantDB);
    return await CatalogItem.findOne({ _id: id, type: "Product" })
      .populate("category", "name color icon")
      .populate("createdBy", "firstName lastName email")
      .populate("updatedBy", "firstName lastName email");
  }

  /**
   * Create a new physical product
   */
  static async createProduct(tenantDB, userId, productData) {
    const { CatalogItem, CatalogCategory } = getTenantModels(tenantDB);
    const {
      name,
      sku,
      category,
      description = "",
      unitPrice,
      currency = "INR",
      taxRate = 18,
      billingUnit = "unit",
      hsnSac = "",
      brand = "",
      modelNumber = "",
      warrantyPeriod = "",
      dimensions = "",
      weight = "",
      attributes = {},
      isActive = true,
    } = productData;

    if (!name || !name.trim()) throw new Error("Product name is required");
    if (!sku || !sku.trim()) throw new Error("Product SKU code is required");
    if (unitPrice === undefined || isNaN(Number(unitPrice)) || Number(unitPrice) < 0) {
      throw new Error("A valid positive unit price is required");
    }

    const trimmedSku = sku.trim().toUpperCase();
    const existing = await CatalogItem.findOne({ sku: trimmedSku });
    if (existing) {
      const err = new Error(`A product with SKU "${trimmedSku}" already exists`);
      err.statusCode = 409;
      throw err;
    }

    let categoryDoc = null;
    let categoryName = "";
    if (category) {
      categoryDoc = await CatalogCategory.findById(category);
      if (!categoryDoc) throw new Error("Selected category not found");
      categoryName = categoryDoc.name;
    }

    const product = new CatalogItem({
      name: name.trim(),
      sku: trimmedSku,
      type: "Product",
      category: categoryDoc ? categoryDoc._id : null,
      categoryName,
      description: description.trim(),
      unitPrice: Number(unitPrice),
      currency: currency.trim().toUpperCase(),
      taxRate: Number(taxRate) >= 0 ? Number(taxRate) : 0,
      billingUnit: billingUnit || "unit",
      hsnSac: hsnSac.trim(),
      attributes: {
        ...attributes,
        brand: brand.trim(),
        modelNumber: modelNumber.trim(),
        warrantyPeriod: warrantyPeriod.trim(),
        dimensions: dimensions.trim(),
        weight: weight.trim(),
      },
      isActive: Boolean(isActive),
      createdBy: userId,
      updatedBy: userId,
    });

    await product.save();
    await product.populate("category", "name color icon");
    return product;
  }

  /**
   * Update existing physical product
   */
  static async updateProduct(tenantDB, userId, id, updateData) {
    const { CatalogItem, CatalogCategory } = getTenantModels(tenantDB);
    const product = await CatalogItem.findOne({ _id: id, type: "Product" });
    if (!product) {
      const err = new Error("Product not found");
      err.statusCode = 404;
      throw err;
    }

    const {
      name,
      sku,
      category,
      description,
      unitPrice,
      currency,
      taxRate,
      billingUnit,
      hsnSac,
      brand,
      modelNumber,
      warrantyPeriod,
      dimensions,
      weight,
      attributes,
      isActive,
    } = updateData;

    if (sku !== undefined) {
      if (!sku.trim()) throw new Error("SKU cannot be empty");
      const trimmedSku = sku.trim().toUpperCase();
      const existing = await CatalogItem.findOne({ _id: { $ne: id }, sku: trimmedSku });
      if (existing) {
        const err = new Error(`Another item with SKU "${trimmedSku}" already exists`);
        err.statusCode = 409;
        throw err;
      }
      product.sku = trimmedSku;
    }

    if (name !== undefined) {
      if (!name.trim()) throw new Error("Product name cannot be empty");
      product.name = name.trim();
    }

    if (category !== undefined) {
      if (category) {
        const categoryDoc = await CatalogCategory.findById(category);
        if (!categoryDoc) throw new Error("Selected category not found");
        product.category = categoryDoc._id;
        product.categoryName = categoryDoc.name;
      } else {
        product.category = null;
        product.categoryName = "";
      }
    }

    if (description !== undefined) product.description = description.trim();
    if (unitPrice !== undefined) {
      if (isNaN(Number(unitPrice)) || Number(unitPrice) < 0) throw new Error("Price must be a positive number");
      product.unitPrice = Number(unitPrice);
    }
    if (currency !== undefined) product.currency = currency.trim().toUpperCase();
    if (taxRate !== undefined) product.taxRate = Number(taxRate);
    if (billingUnit !== undefined) product.billingUnit = billingUnit;
    if (hsnSac !== undefined) product.hsnSac = hsnSac.trim();
    if (isActive !== undefined) product.isActive = Boolean(isActive);

    const mergedAttrs = { ...(product.attributes || {}), ...(attributes || {}) };
    if (brand !== undefined) mergedAttrs.brand = brand.trim();
    if (modelNumber !== undefined) mergedAttrs.modelNumber = modelNumber.trim();
    if (warrantyPeriod !== undefined) mergedAttrs.warrantyPeriod = warrantyPeriod.trim();
    if (dimensions !== undefined) mergedAttrs.dimensions = dimensions.trim();
    if (weight !== undefined) mergedAttrs.weight = weight.trim();
    product.attributes = mergedAttrs;

    product.updatedBy = userId;
    await product.save();
    await product.populate("category", "name color icon");
    return product;
  }

  /**
   * Delete product, protecting against orphaned services attached to it
   */
  static async deleteProduct(tenantDB, id) {
    const { CatalogItem } = getTenantModels(tenantDB);
    const product = await CatalogItem.findOne({ _id: id, type: "Product" });
    if (!product) {
      const err = new Error("Product not found");
      err.statusCode = 404;
      throw err;
    }

    const linkedServicesCount = await CatalogItem.countDocuments({ parentProduct: id });
    if (linkedServicesCount > 0) {
      const err = new Error(`Cannot delete this product because ${linkedServicesCount} service(s) are linked to it. Please reassign or delete them first.`);
      err.statusCode = 400;
      throw err;
    }

    await CatalogItem.findByIdAndDelete(id);
    return product;
  }
}
