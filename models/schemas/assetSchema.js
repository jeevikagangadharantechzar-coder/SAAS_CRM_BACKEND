import mongoose from "mongoose";

export const ASSET_STATUS_LIST = ["In stock", "Assigned", "In use", "Under maintenance", "Retired"];

const assetSchema = new mongoose.Schema(
  {
    category: { type: mongoose.Schema.Types.ObjectId, ref: "AssetCategory", required: true, index: true },

    // Core fields — always present on every asset, regardless of category.
    name:       { type: String, required: true, trim: true },
    status:     { type: String, enum: ASSET_STATUS_LIST, default: "In stock" },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    // Per-category dynamic field values, keyed by the field's _id (string) from
    // the owning category's `fields` array. Left as Mixed since a value can be
    // text, a number, or a date string depending on that field's type.
    fieldValues: { type: mongoose.Schema.Types.Mixed, default: {} },

    // Real number (not a display string) so totals/reports can sum it later.
    value: { type: Number, default: null },

    // Single free-text note — lighter than a full comment thread.
    notes: { type: String, default: "" },

    // Ad-hoc fields for this one asset only — unlike fieldValues (which are
    // defined once on the category and shared by every asset in it), these
    // are added on the fly per-asset and never touch the category's schema.
    // Same shape/purpose as Invoice's customFields.
    customFields: [
      {
        label: { type: String, required: true },
        type:  { type: String, enum: ["text", "number", "date"], default: "text" },
        value: { type: String, default: "" },
      },
    ],

    createdBy:     { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    lastUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

assetSchema.index({ status: 1 });
assetSchema.index({ assignedTo: 1 });

export default assetSchema;
