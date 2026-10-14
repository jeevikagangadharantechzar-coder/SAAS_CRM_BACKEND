import { ProductService } from "../services/product.service.js";

/**
 * Product Controller:
 * Dedicated exclusively to Physical Products (Hardware, Goods, Inventory).
 */

export const getProducts = async (req, res) => {
  try {
    const result = await ProductService.listProducts(req.tenantDB, req.query);
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error("Get products error:", err);
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const getProductById = async (req, res) => {
  try {
    const product = await ProductService.getProductById(req.tenantDB, req.params.id);
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    res.status(200).json({ success: true, product });
  } catch (err) {
    console.error("Get product by ID error:", err);
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const createProduct = async (req, res) => {
  try {
    const product = await ProductService.createProduct(req.tenantDB, req.user._id, req.body);
    res.status(201).json({ success: true, message: "Product created successfully", product });
  } catch (err) {
    console.error("Create product error:", err);
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: "A product with this SKU already exists" });
    }
    res.status(err.statusCode || 400).json({ success: false, message: err.message });
  }
};

export const updateProduct = async (req, res) => {
  try {
    const product = await ProductService.updateProduct(req.tenantDB, req.user._id, req.params.id, req.body);
    res.status(200).json({ success: true, message: "Product updated successfully", product });
  } catch (err) {
    console.error("Update product error:", err);
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: "A product with this SKU already exists" });
    }
    res.status(err.statusCode || 400).json({ success: false, message: err.message });
  }
};

export const deleteProduct = async (req, res) => {
  try {
    const product = await ProductService.deleteProduct(req.tenantDB, req.params.id);
    res.status(200).json({
      success: true,
      message: `Product "${product.name}" deleted successfully`,
    });
  } catch (err) {
    console.error("Delete product error:", err);
    res.status(err.statusCode || 400).json({ success: false, message: err.message });
  }
};

// ==================== PRODUCT CATEGORIES (Handled directly here) ====================

export const getProductCategories = async (req, res) => {
  try {
    const { getTenantModels } = await import("../models/tenant/index.js");
    const { CatalogCategory } = getTenantModels(req.tenantDB);
    const { search, isActive } = req.query;

    const query = {};
    if (search && search.trim()) {
      query.name = { $regex: search.trim(), $options: "i" };
    }
    if (isActive !== undefined && isActive !== "") {
      query.isActive = isActive === "true" || isActive === true;
    }

    const categories = await CatalogCategory.find(query).sort({ name: 1 });
    res.status(200).json({ success: true, categories });
  } catch (err) {
    console.error("Get categories error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createProductCategory = async (req, res) => {
  try {
    const { getTenantModels } = await import("../models/tenant/index.js");
    const { CatalogCategory } = getTenantModels(req.tenantDB);
    const { name, description, color, icon } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Category name is required" });
    }

    const trimmedName = name.trim();
    const existing = await CatalogCategory.findOne({
      name: { $regex: `^${trimmedName}$`, $options: "i" },
    });
    if (existing) {
      return res.status(409).json({ success: false, message: "Category already exists" });
    }

    const category = new CatalogCategory({
      name: trimmedName,
      description: description ? description.trim() : "",
      color: color || "#22415F",
      icon: icon || "📦",
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });

    await category.save();
    res.status(201).json({ success: true, message: "Category created successfully", category });
  } catch (err) {
    console.error("Create category error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updateProductCategory = async (req, res) => {
  try {
    const { getTenantModels } = await import("../models/tenant/index.js");
    const { CatalogCategory, CatalogItem } = getTenantModels(req.tenantDB);
    const { id } = req.params;
    const { name, description, color, icon, isActive } = req.body;

    const category = await CatalogCategory.findById(id);
    if (!category) return res.status(404).json({ success: false, message: "Category not found" });

    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ success: false, message: "Category name cannot be empty" });
      const trimmedName = name.trim();
      category.name = trimmedName;
      await CatalogItem.updateMany({ category: id }, { $set: { categoryName: trimmedName } });
    }
    if (description !== undefined) category.description = description.trim();
    if (color !== undefined) category.color = color;
    if (icon !== undefined) category.icon = icon;
    if (isActive !== undefined) category.isActive = Boolean(isActive);

    category.updatedBy = req.user._id;
    await category.save();
    res.status(200).json({ success: true, message: "Category updated successfully", category });
  } catch (err) {
    console.error("Update category error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteProductCategory = async (req, res) => {
  try {
    const { getTenantModels } = await import("../models/tenant/index.js");
    const { CatalogCategory, CatalogItem } = getTenantModels(req.tenantDB);
    const { id } = req.params;

    const itemCount = await CatalogItem.countDocuments({ category: id });
    if (itemCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete category. ${itemCount} item(s) are using it.`,
      });
    }

    await CatalogCategory.findByIdAndDelete(id);
    res.status(200).json({ success: true, message: "Category deleted successfully" });
  } catch (err) {
    console.error("Delete category error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
