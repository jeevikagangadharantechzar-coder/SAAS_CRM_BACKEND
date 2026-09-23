import express from "express";
import { protect, requirePermission } from "../middlewares/auth.middleware.js";
import checkPlanFeature from "../middlewares/checkPlanFeature.js";
import { getCategories, createCategory, updateCategory, deleteCategory } from "../controllers/assetCategory.controller.js";
import { getAssets, getAssetById, createAsset, updateAsset, deleteAsset } from "../controllers/asset.controller.js";

const router = express.Router();

router.use(checkPlanFeature("assets"));
router.use(protect, requirePermission("assets"));

// Reading categories only needs the general "assets" permission already
// applied above; creating/editing/deleting one is shared tenant-wide
// structure, so it additionally needs "assets_manage_categories" — Admins
// always pass both (requirePermission has a built-in Admin bypass), other
// roles only pass the second check if a tenant admin explicitly grants it.
router.get("/categories", getCategories);
router.post("/categories", requirePermission("assets_manage_categories"), createCategory);
router.put("/categories/:id", requirePermission("assets_manage_categories"), updateCategory);
router.delete("/categories/:id", requirePermission("assets_manage_categories"), deleteCategory);

router.get("/", getAssets);
router.get("/:id", getAssetById);
router.post("/", createAsset);
router.put("/:id", updateAsset);
router.delete("/:id", deleteAsset);

export default router;
