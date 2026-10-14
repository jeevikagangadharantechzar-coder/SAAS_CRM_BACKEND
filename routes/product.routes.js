import express from "express";
import { protect, requirePermission, adminOnly } from "../middlewares/auth.middleware.js";
import checkPlanFeature from "../middlewares/checkPlanFeature.js";
import {
  getProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  getProductCategories,
  createProductCategory,
  updateProductCategory,
  deleteProductCategory,
} from "../controllers/product.controller.js";

const router = express.Router();

router.use(protect);
router.use(checkPlanFeature("products_services"));

// Categories routes (under products)
router.get("/categories", requirePermission("products_services"), getProductCategories);
router.post("/categories", adminOnly, createProductCategory);
router.put("/categories/:id", adminOnly, updateProductCategory);
router.delete("/categories/:id", adminOnly, deleteProductCategory);

// Products routes
router.get("/", requirePermission("products_services"), getProducts);
router.get("/:id", requirePermission("products_services"), getProductById);
router.post("/", adminOnly, createProduct);
router.put("/:id", adminOnly, updateProduct);
router.delete("/:id", adminOnly, deleteProduct);

export default router;
