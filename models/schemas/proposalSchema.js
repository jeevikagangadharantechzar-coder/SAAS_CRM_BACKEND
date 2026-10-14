import mongoose from "mongoose";

const ProposalSchema = new mongoose.Schema(
  {
    title:    { type: String, required: true },
    deal:     { type: mongoose.Schema.Types.ObjectId, ref: "Deal", required: false },
    dealTitle:{ type: String, required: true },
    createdBy:    { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    lastUpdatedBy:{ type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    email:    { type: String, required: true },
    cc:       { type: String },
    content:  { type: String, required: false, default: "" },
    image:    { type: String },
    value:    { type: String, required: true },
    currency: { type: String, default: "INR" },
    subtotal: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    tax:      { type: Number, default: 0 },
    items: [
      {
        catalogItem: { type: mongoose.Schema.Types.ObjectId, ref: "CatalogItem" },
        name:        { type: String, required: true },
        sku:         { type: String, default: "" },
        type:        { type: String, enum: ["Product", "Service"], default: "Product" },
        category:    { type: mongoose.Schema.Types.ObjectId, ref: "CatalogCategory", default: null },
        categoryName:{ type: String, default: "" },
        description: { type: String, default: "" },
        billingUnit: { type: String, default: "unit" },
        hsnSac:      { type: String, default: "" },
        unitPrice:   { type: Number, required: true, min: 0 },
        quantity:    { type: Number, required: true, min: 0.01, default: 1 },
        taxRate:     { type: Number, default: 0, min: 0 },
        discount:    { type: Number, default: 0, min: 0 },
        lineTotal:   { type: Number, required: true, min: 0 },
      },
    ],
    companyName: { type: String },
    status: {
      type: String,
      enum: ["draft", "sent", "no reply", "rejection", "success"],
      default: "draft",
    },
    // Every status transition, oldest first — status alone only ever shows
    // the current value, so without this a proposal that went
    // draft → success → no reply → sent would show only "sent" in the
    // Activity Log, with every earlier transition silently lost.
    statusHistory: [
      {
        status:    { type: String, enum: ["draft", "sent", "no reply", "rejection", "success"] },
        changedAt: { type: Date, default: Date.now },
        changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      },
    ],
    followUpDate:    { type: Date, default: Date.now },
    followUpComment: { type: String, default: "" },
    lastReminderAt:  { type: Date },
    attachments: [
      {
        name: {
          type: String,
          required: true,
          get: function (v) { return v; },
          set: function (v) { return v; },
        },
        filename:   { type: String },
        path:       { type: String, required: true },
        type:       { type: String },
        size:       { type: Number },
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

export default ProposalSchema;
