import express from "express";
import { protect, requirePermission, adminOnly } from "../middlewares/auth.middleware.js";
import checkPlanFeature from "../middlewares/checkPlanFeature.js";
import {
  getCatalogItems,
  getCatalogItemById,
  createCatalogItem,
  updateCatalogItem,
  toggleCatalogItemStatus,
  deleteCatalogItem,
} from "../controllers/catalogItem.controller.js";
import {
  getProductCategories as getCatalogCategories,
  createProductCategory as createCatalogCategory,
  updateProductCategory as updateCatalogCategory,
  deleteProductCategory as deleteCatalogCategory,
} from "../controllers/product.controller.js";

import { getConversionRate } from "../services/currencyService.js";

const router = express.Router();

router.use(protect);
router.use(checkPlanFeature("products_services"));

// Live Currency Conversion route
router.get("/exchange-rate", async (req, res) => {
  try {
    const { from = "INR", to = "USD", amount } = req.query;
    const rate = await getConversionRate(from.toUpperCase(), to.toUpperCase());
    const parsedAmount = parseFloat(amount);
    const convertedAmount = !isNaN(parsedAmount)
      ? Number((parsedAmount * rate).toFixed(2))
      : null;

    res.status(200).json({
      success: true,
      from: from.toUpperCase(),
      to: to.toUpperCase(),
      rate,
      originalAmount: isNaN(parsedAmount) ? null : parsedAmount,
      convertedAmount,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Categories routes
// Listing categories: available to users with products_services permission
router.get("/categories", requirePermission("products_services"), getCatalogCategories);
// Managing categories: requires manage_catalog_categories or Admin
router.post("/categories", requirePermission("manage_catalog_categories"), createCatalogCategory);
router.put("/categories/:id", requirePermission("manage_catalog_categories"), updateCatalogCategory);
router.delete("/categories/:id", requirePermission("manage_catalog_categories"), deleteCatalogCategory);

// Catalog Items routes
// List & get: accessible to users with products_services or sales roles
router.get("/", requirePermission("products_services"), getCatalogItems);
router.get("/:id", requirePermission("products_services"), getCatalogItemById);

// Create, update, toggle, delete: Admin only (or authorized admins)
router.post("/", adminOnly, createCatalogItem);
router.put("/:id", adminOnly, updateCatalogItem);
router.patch("/:id/toggle-status", adminOnly, toggleCatalogItemStatus);
router.delete("/:id", adminOnly, deleteCatalogItem);

export default router;
