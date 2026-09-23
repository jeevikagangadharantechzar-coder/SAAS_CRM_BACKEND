import { getTenantModels } from "../models/tenant/index.js";

const getModels = (req) => getTenantModels(req.tenantDB);

const isAdmin = (req) => req.user.role?.name?.toLowerCase() === "admin";

// Drop rows with no label (the schema requires one) instead of letting a
// half-filled row fail the whole save, and coerce type to a known value.
const sanitizeCustomFields = (customFields) => {
  if (!Array.isArray(customFields)) return [];
  return customFields
    .filter((f) => f && String(f.label || "").trim())
    .map((f) => ({
      label: String(f.label).trim(),
      type: ["text", "number", "date"].includes(f.type) ? f.type : "text",
      value: f.value === undefined || f.value === null ? "" : String(f.value),
    }));
};

export const getAssets = async (req, res) => {
  try {
    const { Asset } = getModels(req);
    const { category, status, assignedTo, search, page = 1, limit = 20 } = req.query;
    const query = {};

    // Sales only ever sees what's assigned to them — same visibility rule
    // already used for Leads/Deals in this codebase.
    if (!isAdmin(req)) {
      query.assignedTo = req.user._id;
    } else if (assignedTo && assignedTo !== "All") {
      query.assignedTo = assignedTo === "Unassigned" ? null : assignedTo;
    }

    if (category && category !== "All") query.category = category;
    if (status && status !== "All") query.status = status;
    if (search?.trim()) query.name = { $regex: search.trim(), $options: "i" };

    const pageNum = Math.max(Number(page) || 1, 1);
    const limitNum = Math.max(Number(limit) || 20, 1);
    const skip = (pageNum - 1) * limitNum;

    const [assets, totalAssets] = await Promise.all([
      Asset.find(query)
        .populate("category")
        .populate("assignedTo", "firstName lastName email")
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limitNum),
      Asset.countDocuments(query),
    ]);

    res.json({
      success: true,
      assets,
      totalAssets,
      totalPages: Math.ceil(totalAssets / limitNum),
      currentPage: pageNum,
    });
  } catch (err) {
    console.error("Get assets error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

export const getAssetById = async (req, res) => {
  try {
    const { Asset } = getModels(req);
    const asset = await Asset.findById(req.params.id)
      .populate("category")
      .populate("assignedTo", "firstName lastName email");
    if (!asset) return res.status(404).json({ success: false, error: "Asset not found" });

    if (!isAdmin(req) && String(asset.assignedTo?._id || asset.assignedTo) !== String(req.user._id)) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    res.json({ success: true, asset });
  } catch (err) {
    console.error("Get asset error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

export const createAsset = async (req, res) => {
  try {
    const { category, name, status, assignedTo, value, notes, fieldValues, customFields } = req.body;
    if (!category) return res.status(400).json({ success: false, error: "Category is required" });
    if (!name?.trim()) return res.status(400).json({ success: false, error: "Asset name is required" });

    const { AssetCategory, Asset } = getModels(req);
    const categoryDoc = await AssetCategory.findById(category);
    if (!categoryDoc) return res.status(404).json({ success: false, error: "Category not found" });

    // A non-admin can only ever see/edit assets assigned to them (getAssets,
    // getAssetById, updateAsset all enforce this) — so letting them create
    // one assigned to someone else would immediately orphan it from their own
    // view the moment it's saved. Force it to themselves regardless of what
    // was sent, same as the read-side enforcement.
    const resolvedAssignedTo = isAdmin(req) ? (assignedTo || null) : req.user._id;

    const asset = await Asset.create({
      category,
      name: name.trim(),
      status: status || "In stock",
      assignedTo: resolvedAssignedTo,
      value: value === undefined || value === null || value === "" ? null : Number(value),
      notes: notes || "",
      fieldValues: fieldValues || {},
      customFields: sanitizeCustomFields(customFields),
      createdBy: req.user._id,
    });

    const populated = await Asset.findById(asset._id)
      .populate("category")
      .populate("assignedTo", "firstName lastName email");

    res.status(201).json({ success: true, asset: populated, message: "Asset created successfully" });
  } catch (err) {
    console.error("Create asset error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

export const updateAsset = async (req, res) => {
  try {
    const { category, name, status, assignedTo, value, notes, fieldValues, customFields } = req.body;
    const { Asset, AssetCategory } = getModels(req);
    const asset = await Asset.findById(req.params.id);
    if (!asset) return res.status(404).json({ success: false, error: "Asset not found" });

    if (!isAdmin(req) && String(asset.assignedTo) !== String(req.user._id)) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    if (category !== undefined) {
      const categoryDoc = await AssetCategory.findById(category);
      if (!categoryDoc) return res.status(404).json({ success: false, error: "Category not found" });
      asset.category = category;
    }
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ success: false, error: "Asset name is required" });
      asset.name = name.trim();
    }
    if (status !== undefined) {
      asset.status = status;
      // Same small rule the approved prototype has — a retired asset shouldn't
      // stay "assigned" to someone who no longer has it.
      if (status === "Retired") asset.assignedTo = null;
    }
    if (assignedTo !== undefined && status !== "Retired") asset.assignedTo = assignedTo || null;
    if (value !== undefined) asset.value = value === null || value === "" ? null : Number(value);
    if (notes !== undefined) asset.notes = notes;
    if (fieldValues !== undefined) asset.fieldValues = fieldValues;
    if (customFields !== undefined) asset.customFields = sanitizeCustomFields(customFields);
    asset.lastUpdatedBy = req.user._id;

    await asset.save();
    const populated = await Asset.findById(asset._id)
      .populate("category")
      .populate("assignedTo", "firstName lastName email");

    res.json({ success: true, asset: populated, message: "Asset updated successfully" });
  } catch (err) {
    console.error("Update asset error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

export const deleteAsset = async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ success: false, error: "Only Admin can delete assets" });

    const { Asset } = getModels(req);
    const asset = await Asset.findById(req.params.id);
    if (!asset) return res.status(404).json({ success: false, error: "Asset not found" });

    await Asset.findByIdAndDelete(asset._id);
    res.json({ success: true, message: "Asset deleted successfully" });
  } catch (err) {
    console.error("Delete asset error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};
