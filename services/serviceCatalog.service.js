import { getTenantModels } from "../models/tenant/index.js";
import { BILLING_UNITS } from "../models/schemas/catalogItemSchema.js";

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * ServiceCatalogService: Dedicated Business Logic & DB queries exclusively for Services
 * Handles parent product linkage, auto-inheritance of category/currency, and service SLA/scope.
 */
export class ServiceCatalogService {
  /**
   * List paginated services with populated parent product information
   */
  static async listServices(tenantDB, {
    page = 1,
    limit = 20,
    search,
    parentProduct,
    category,
    isActive,
    startDate,
    endDate,
    sort = "createdAt",
    order = "desc",
  }) {
    const { CatalogItem } = getTenantModels(tenantDB);
    const query = { type: "Service" };

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
        { serviceType: { $regex: searchRegex, $options: "i" } },
        { parentProductName: { $regex: searchRegex, $options: "i" } },
      ];
    }

    if (parentProduct) {
      query.parentProduct = parentProduct;
    }

    if (category) {
      query.category = category;
    }

    if (isActive !== undefined && isActive !== "") {
      query.isActive = isActive === "true" || isActive === true;
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const skip = (pageNum - 1) * limitNum;

    const sortOrder = order === "asc" ? 1 : -1;
    const sortField = ["name", "sku", "unitPrice", "createdAt"].includes(sort)
      ? sort
      : "createdAt";

    const [items, total] = await Promise.all([
      CatalogItem.find(query)
        .populate("parentProduct", "name sku unitPrice currency")
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
   * Get single service by ID
   */
  static async getServiceById(tenantDB, id) {
    const { CatalogItem } = getTenantModels(tenantDB);
    return await CatalogItem.findOne({ _id: id, type: "Service" })
      .populate("parentProduct", "name sku unitPrice currency")
      .populate("category", "name color icon")
      .populate("createdBy", "firstName lastName email")
      .populate("updatedBy", "firstName lastName email");
  }

  /**
   * Create a new service linked to an existing product
   * Automatically inherits product details (category, currency, tax) and derives SKU
   */
  static async createService(tenantDB, userId, serviceData) {
    const { CatalogItem, CatalogCategory } = getTenantModels(tenantDB);
    const {
      name,
      sku,
      category,
      categoryName,
      currency = "INR",
      parentProduct,
      unitPrice,
      billingUnit = "year",
      serviceType = "Installation & Setup",
      deliveryMode = "On-site",
      slaResponseTime = "",
      duration = "",
      serviceScope = "",
      deliverables = "",
      taxRate,
      hsnSac,
      attributes = {},
      isActive = true,
    } = serviceData;

    if (!name || !name.trim()) throw new Error("Service name is required");
    if (unitPrice === undefined || isNaN(Number(unitPrice)) || Number(unitPrice) < 0) {
      throw new Error("A valid service price is required");
    }

    // Retrieve linked product if provided
    let parentProductDoc = null;
    if (parentProduct) {
      parentProductDoc = await CatalogItem.findById(parentProduct);
      if (!parentProductDoc) {
        const err = new Error("Selected parent product not found");
        err.statusCode = 404;
        throw err;
      }
    }

    // Auto-generate clean SKU
    let finalSku = (sku || "").trim().toUpperCase();
    if (!finalSku) {
      const basePrefix = parentProductDoc?.sku
        ? `${parentProductDoc.sku}-SVC`
        : `SVC-${Date.now().toString(36).toUpperCase()}`;
      let candidateSku = basePrefix;
      let counter = 1;
      while (await CatalogItem.findOne({ sku: candidateSku })) {
        candidateSku = `${basePrefix}-${counter++}`;
      }
      finalSku = candidateSku;
    } else {
      const existing = await CatalogItem.findOne({ sku: finalSku });
      if (existing) {
        const err = new Error(`A service with SKU "${finalSku}" already exists`);
        err.statusCode = 409;
        throw err;
      }
    }

    const service = new CatalogItem({
      name: name.trim(),
      sku: finalSku,
      type: "Service",
      parentProduct: parentProductDoc ? parentProductDoc._id : null,
      parentProductName: parentProductDoc ? parentProductDoc.name : "",
      category: parentProductDoc ? (parentProductDoc.category || null) : (category || null),
      categoryName: parentProductDoc ? (parentProductDoc.categoryName || "") : (categoryName || ""),
      currency: parentProductDoc ? (parentProductDoc.currency || "INR") : (currency || "INR"),
      taxRate: taxRate !== undefined && !isNaN(Number(taxRate))
        ? Number(taxRate)
        : (parentProductDoc ? (parentProductDoc.taxRate ?? 18) : 18),
      billingUnit: billingUnit || "year",
      hsnSac: (hsnSac || parentProductDoc?.hsnSac || "").trim(),
      unitPrice: Number(unitPrice),
      serviceType: serviceType.trim(),
      deliveryMode: deliveryMode.trim(),
      description: serviceScope.trim(),
      attributes: {
        ...attributes,
        serviceType: serviceType.trim(),
        deliveryMode: deliveryMode.trim(),
        slaResponseTime: slaResponseTime.trim(),
        duration: duration.trim(),
        serviceScope: serviceScope.trim(),
        deliverables: deliverables.trim(),
      },
      isActive: Boolean(isActive),
      createdBy: userId,
      updatedBy: userId,
    });

    await service.save();
    await service.populate("parentProduct", "name sku unitPrice currency");
    await service.populate("category", "name color icon");
    return service;
  }

  /**
   * Update existing service
   */
  static async updateService(tenantDB, userId, id, updateData) {
    const { CatalogItem } = getTenantModels(tenantDB);
    const service = await CatalogItem.findOne({ _id: id, type: "Service" });
    if (!service) {
      const err = new Error("Service not found");
      err.statusCode = 404;
      throw err;
    }

    const {
      name,
      sku,
      category,
      categoryName,
      currency,
      parentProduct,
      unitPrice,
      billingUnit,
      serviceType,
      deliveryMode,
      slaResponseTime,
      duration,
      serviceScope,
      deliverables,
      taxRate,
      hsnSac,
      attributes,
      isActive,
    } = updateData;

    if (name !== undefined) {
      if (!name.trim()) throw new Error("Service name cannot be empty");
      service.name = name.trim();
    }

    if (sku !== undefined && sku.trim()) {
      const trimmedSku = sku.trim().toUpperCase();
      const existing = await CatalogItem.findOne({ _id: { $ne: id }, sku: trimmedSku });
      if (existing) {
        const err = new Error(`Another service with SKU "${trimmedSku}" already exists`);
        err.statusCode = 409;
        throw err;
      }
      service.sku = trimmedSku;
    }

    if (parentProduct !== undefined) {
      if (parentProduct) {
        const parentDoc = await CatalogItem.findById(parentProduct);
        if (parentDoc) {
          service.parentProduct = parentDoc._id;
          service.parentProductName = parentDoc.name;
          service.category = parentDoc.category;
          service.categoryName = parentDoc.categoryName;
          service.currency = parentDoc.currency;
        }
      } else {
        service.parentProduct = null;
        service.parentProductName = "";
        if (category !== undefined) service.category = category || null;
        if (categoryName !== undefined) service.categoryName = categoryName || "";
        if (currency !== undefined) service.currency = currency || "INR";
      }
    } else {
      if (category !== undefined) service.category = category || null;
      if (categoryName !== undefined) service.categoryName = categoryName || "";
      if (currency !== undefined) service.currency = currency || "INR";
    }

    if (unitPrice !== undefined) {
      if (isNaN(Number(unitPrice)) || Number(unitPrice) < 0) throw new Error("Price must be a valid positive number");
      service.unitPrice = Number(unitPrice);
    }
    if (billingUnit !== undefined) service.billingUnit = billingUnit;
    if (serviceType !== undefined) service.serviceType = serviceType.trim();
    if (deliveryMode !== undefined) service.deliveryMode = deliveryMode.trim();
    if (taxRate !== undefined) service.taxRate = Number(taxRate);
    if (hsnSac !== undefined) service.hsnSac = hsnSac.trim();
    if (isActive !== undefined) service.isActive = Boolean(isActive);

    const mergedAttrs = { ...(service.attributes || {}), ...(attributes || {}) };
    if (serviceType !== undefined) mergedAttrs.serviceType = serviceType.trim();
    if (deliveryMode !== undefined) mergedAttrs.deliveryMode = deliveryMode.trim();
    if (slaResponseTime !== undefined) mergedAttrs.slaResponseTime = slaResponseTime.trim();
    if (duration !== undefined) mergedAttrs.duration = duration.trim();
    if (serviceScope !== undefined) {
      mergedAttrs.serviceScope = serviceScope.trim();
      service.description = serviceScope.trim();
    }
    if (deliverables !== undefined) mergedAttrs.deliverables = deliverables.trim();
    service.attributes = mergedAttrs;

    service.updatedBy = userId;
    await service.save();
    await service.populate("parentProduct", "name sku unitPrice currency");
    return service;
  }

  /**
   * Delete service
   */
  static async deleteService(tenantDB, id) {
    const { CatalogItem } = getTenantModels(tenantDB);
    const service = await CatalogItem.findOneAndDelete({ _id: id, type: "Service" });
    if (!service) {
      const err = new Error("Service not found");
      err.statusCode = 404;
      throw err;
    }
    return service;
  }
}
