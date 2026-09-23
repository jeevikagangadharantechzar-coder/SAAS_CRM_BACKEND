import { getTenantModels } from "../models/tenant/index.js";

const getModels = (req) => getTenantModels(req.tenantDB);

// Seeded once per tenant, the first time they ever open the Categories tab —
// gives every tenant a usable starting point across different industries,
// exactly like the approved prototype. These become normal, fully-editable
// categories the moment they're created; nothing about them stays special.
const STARTER_CATEGORIES = [
  {
    name: "Real Estate Properties", icon: "🏠", color: "#22415F",
    fields: [
      { label: "Address", type: "Text" },
      { label: "Size (sqft)", type: "Number" },
      { label: "Lease End Date", type: "Date" },
      { label: "Property Type", type: "Dropdown", options: ["Residential", "Commercial", "Industrial"] },
    ],
  },
  {
    name: "IT Equipment", icon: "💻", color: "#2F7A5C",
    fields: [
      { label: "Serial Number", type: "Text" },
      { label: "Model", type: "Text" },
      { label: "Warranty Expiry", type: "Date" },
    ],
  },
  {
    name: "Software Licenses", icon: "🔑", color: "#5B4B8A",
    fields: [
      { label: "License Key", type: "Text" },
      { label: "Seat Count", type: "Number" },
      { label: "Renewal Date", type: "Date" },
      { label: "Vendor", type: "Text" },
    ],
  },
  {
    name: "Manufacturing Equipment", icon: "⚙️", color: "#B8792D",
    fields: [
      { label: "Machine ID", type: "Text" },
      { label: "Last Calibration", type: "Date" },
      { label: "Maintenance Cycle", type: "Dropdown", options: ["Monthly", "Quarterly", "Yearly"] },
    ],
  },
];

export const getCategories = async (req, res) => {
  try {
    const { AssetCategory } = getModels(req);
    let categories = await AssetCategory.find().sort({ createdAt: 1 });

    if (categories.length === 0) {
      categories = await AssetCategory.insertMany(
        STARTER_CATEGORIES.map((c) => ({ ...c, createdBy: req.user._id }))
      );
    }

    res.json({ success: true, categories });
  } catch (err) {
    console.error("Get asset categories error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

export const createCategory = async (req, res) => {
  try {
    const { name, icon, color, fields } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ success: false, error: "Category name is required" });
    }

    const { AssetCategory } = getModels(req);
    const category = await AssetCategory.create({
      name: name.trim(),
      icon: icon || "📦",
      color: color || "#22415F",
      fields: Array.isArray(fields) ? fields : [],
      createdBy: req.user._id,
    });

    res.status(201).json({ success: true, category, message: "Category created successfully" });
  } catch (err) {
    console.error("Create asset category error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

export const updateCategory = async (req, res) => {
  try {
    const { name, icon, color, fields } = req.body;
    const { AssetCategory } = getModels(req);
    const category = await AssetCategory.findById(req.params.id);
    if (!category) return res.status(404).json({ success: false, error: "Category not found" });

    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ success: false, error: "Category name is required" });
      category.name = name.trim();
    }
    if (icon !== undefined) category.icon = icon;
    if (color !== undefined) category.color = color;
    if (fields !== undefined) category.fields = fields;

    await category.save();
    res.json({ success: true, category, message: "Category updated successfully" });
  } catch (err) {
    console.error("Update asset category error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

export const deleteCategory = async (req, res) => {
  try {
    const { AssetCategory, Asset } = getModels(req);
    const category = await AssetCategory.findById(req.params.id);
    if (!category) return res.status(404).json({ success: false, error: "Category not found" });

    const assetCount = await Asset.countDocuments({ category: category._id });
    if (assetCount > 0) {
      return res.status(400).json({
        success: false,
        error: `Cannot delete category. ${assetCount} asset${assetCount === 1 ? "" : "s"} still use${assetCount === 1 ? "s" : ""} it — move or delete them first.`,
      });
    }

    await AssetCategory.findByIdAndDelete(category._id);
    res.json({ success: true, message: "Category deleted successfully" });
  } catch (err) {
    console.error("Delete asset category error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};
