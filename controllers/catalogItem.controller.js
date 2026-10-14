import { ProductService } from "../services/product.service.js";
import { ServiceCatalogService } from "../services/serviceCatalog.service.js";
import { getTenantModels } from "../models/tenant/index.js";

/**
 * Clean Controller Layer:
 * Zero DB logic here. Pure HTTP request parsing, status codes, and routing to:
 * - ProductService for physical products
 * - ServiceCatalogService for services
 */

export const getCatalogItems = async (req, res) => {
  try {
    const { type } = req.query;

    // Calculate global stats for this tenant so stats cards are ALWAYS populated
    const { CatalogItem } = getTenantModels(req.tenantDB);
    const statsAgg = await CatalogItem.aggregate([
      {
        $group: {
          _id: null,
          totalItems: { $sum: 1 },
          productsCount: { $sum: { $cond: [{ $eq: ["$type", "Product"] }, 1, 0] } },
          servicesCount: { $sum: { $cond: [{ $eq: ["$type", "Service"] }, 1, 0] } },
          activeCount: { $sum: { $cond: [{ $eq: ["$isActive", true] }, 1, 0] } },
        },
      },
    ]);

    const stats = statsAgg && statsAgg.length > 0
      ? statsAgg[0]
      : { totalItems: 0, productsCount: 0, servicesCount: 0, activeCount: 0 };
    delete stats._id;

    if (type === "Product") {
      const result = await ProductService.listProducts(req.tenantDB, req.query);
      return res.status(200).json({ success: true, stats, ...result });
    }

    if (type === "Service") {
      const result = await ServiceCatalogService.listServices(req.tenantDB, req.query);
      return res.status(200).json({ success: true, stats, ...result });
    }

    // Unified List with stats
    const pageNum = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const skip = (pageNum - 1) * limitNum;

    const query = {};
    if (req.query.startDate || req.query.endDate) {
      query.createdAt = {};
      if (req.query.startDate) query.createdAt.$gte = new Date(req.query.startDate);
      if (req.query.endDate) {
        const end = new Date(req.query.endDate);
        end.setHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }

    const [items, total] = await Promise.all([
      CatalogItem.find(query)
        .populate("category", "name color icon")
        .populate("parentProduct", "name sku unitPrice currency")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      CatalogItem.countDocuments(query),
    ]);

    res.status(200).json({
      success: true,
      items,
      stats,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum) || 1,
      },
    });
  } catch (err) {
    console.error("Get catalog items error:", err);
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const getCatalogItemById = async (req, res) => {
  try {
    const { CatalogItem } = getTenantModels(req.tenantDB);
    const item = await CatalogItem.findById(req.params.id)
      .populate("category", "name color icon")
      .populate("parentProduct", "name sku unitPrice currency");

    if (!item) return res.status(404).json({ success: false, message: "Catalog item not found" });

    res.status(200).json({ success: true, item });
  } catch (err) {
    console.error("Get catalog item by ID error:", err);
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const createCatalogItem = async (req, res) => {
  try {
    const isService = req.body.type === "Service";
    const item = isService
      ? await ServiceCatalogService.createService(req.tenantDB, req.user._id, req.body)
      : await ProductService.createProduct(req.tenantDB, req.user._id, req.body);

    res.status(201).json({
      success: true,
      message: `${item.type} created successfully`,
      item,
    });
  } catch (err) {
    console.error("Create catalog item error:", err);
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: "A catalog item with this SKU already exists" });
    }
    res.status(err.statusCode || 400).json({ success: false, message: err.message });
  }
};

export const updateCatalogItem = async (req, res) => {
  try {
    const { CatalogItem } = getTenantModels(req.tenantDB);
    const existing = await CatalogItem.findById(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: "Catalog item not found" });

    const item = existing.type === "Service"
      ? await ServiceCatalogService.updateService(req.tenantDB, req.user._id, req.params.id, req.body)
      : await ProductService.updateProduct(req.tenantDB, req.user._id, req.params.id, req.body);

    res.status(200).json({
      success: true,
      message: `${item.type} updated successfully`,
      item,
    });
  } catch (err) {
    console.error("Update catalog item error:", err);
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: "A catalog item with this SKU already exists" });
    }
    res.status(err.statusCode || 400).json({ success: false, message: err.message });
  }
};

export const toggleCatalogItemStatus = async (req, res) => {
  try {
    const { CatalogItem } = getTenantModels(req.tenantDB);
    const item = await CatalogItem.findById(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: "Catalog item not found" });

    item.isActive = !item.isActive;
    item.updatedBy = req.user._id;
    await item.save();

    res.status(200).json({
      success: true,
      message: `Item ${item.isActive ? "activated" : "deactivated"} successfully`,
      item,
    });
  } catch (err) {
    console.error("Toggle item status error:", err);
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const deleteCatalogItem = async (req, res) => {
  try {
    const { CatalogItem } = getTenantModels(req.tenantDB);
    const existing = await CatalogItem.findById(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: "Catalog item not found" });

    const item = existing.type === "Service"
      ? await ServiceCatalogService.deleteService(req.tenantDB, req.params.id)
      : await ProductService.deleteProduct(req.tenantDB, req.params.id);

    res.status(200).json({
      success: true,
      message: `${item.type} "${item.name}" deleted successfully`,
    });
  } catch (err) {
    console.error("Delete catalog item error:", err);
    res.status(err.statusCode || 400).json({ success: false, message: err.message });
  }
};
