import mongoose from "mongoose";

export const CATALOG_TYPES = ["Product", "Service"];
export const BILLING_UNITS = [
  "unit",
  "piece",
  "set",
  "box",
  "pack",
  "kg",
  "meter",
  "liter",
  "hour",
  "day",
  "visit",
  "session",
  "month",
  "year",
  "project",
  "fixed"
];

const catalogItemSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    sku: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    type: {
      type: String,
      enum: CATALOG_TYPES,
      default: "Product",
      required: true,
    },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CatalogCategory",
      default: null,
    },
    categoryName: {
      type: String,
      default: "",
      trim: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    unitPrice: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    currency: {
      type: String,
      default: "INR",
      trim: true,
      uppercase: true,
    },
    taxRate: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    billingUnit: {
      type: String,
      enum: BILLING_UNITS,
      default: "unit",
      trim: true,
    },
    hsnSac: {
      type: String,
      default: "",
      trim: true,
    },
    // If type === "Service": Which product does this service belong to?
    parentProduct: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CatalogItem",
      default: null,
    },
    parentProductName: {
      type: String,
      default: "",
      trim: true,
    },
    // Service-specific nature / category
    serviceType: {
      type: String,
      default: "",
      trim: true,
    },
    deliveryMode: {
      type: String,
      default: "",
      trim: true,
    },
    // Any dynamic / custom attributes or specs
    attributes: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

catalogItemSchema.index({ sku: 1 }, { unique: true });
catalogItemSchema.index({ name: 1 });
catalogItemSchema.index({ type: 1 });
catalogItemSchema.index({ category: 1 });
catalogItemSchema.index({ isActive: 1 });
catalogItemSchema.index({ createdAt: -1 });

export default catalogItemSchema;
