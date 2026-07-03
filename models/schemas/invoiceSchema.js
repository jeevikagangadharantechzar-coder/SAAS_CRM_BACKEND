import mongoose from "mongoose";

const invoiceSchema = new mongoose.Schema(
  {
    invoicenumber: {
      type: String,
      required: true,
      unique: true,
      default: () => `TZI-${Math.floor(Math.random() * 1000000)}`,
    },
    assignTo:  { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    issueDate: { type: Date, required: true },
    dueDate:   { type: Date, required: true },
    status:    { type: String, enum: ["paid", "unpaid", "partially_paid"], required: true },
    // Cumulative amount actually collected so far (grows as partial payments come in)
    amountPaid: { type: Number, default: 0 },

    items: [
      {
        deal:   { type: mongoose.Schema.Types.ObjectId, ref: "Deal", required: true },
        price:  { type: Number, required: true },
        amount: { type: Number, required: true },
      },
    ],

    note: { type: String },

    subtotal:      { type: Number, required: true },
    discount:      { type: Number, default: 0 },
    tax:           { type: Number, default: 0 },
    total:         { type: String, required: true },

    discountValue: { type: Number, default: 0 },
    discountType:  { type: String, enum: ["percentage", "fixed"], default: "percentage" },
    taxValue:      { type: Number, default: 0 },
    taxType:       { type: String, enum: ["percentage", "fixed"], default: "percentage" },

    currency:              { type: String, default: "USD" },
    paidAt:                { type: Date, default: null },
    inrAmount:             { type: Number, default: null },
    exchangeRate:          { type: Number, default: null },
    preferredCurrency:     { type: String, default: null },
    preferredCurrencyValue:{ type: Number, default: null },

    // Client-side fields that vary by country/client — not always applicable
    billingAddress: { type: String, default: "" },
    clientTaxId:    { type: String, default: "" },
    poNumber:       { type: String, default: "" },

    // Admin-defined ad-hoc fields, since invoice requirements vary by country/client
    // and can't all be anticipated up front
    customFields: [
      {
        label: { type: String, required: true },
        type:  { type: String, enum: ["text", "number", "date"], default: "text" },
        value: { type: String, default: "" },
      },
    ],
  },
  { timestamps: true }
);

invoiceSchema.index({ paidAt: 1 });
invoiceSchema.index({ status: 1 });
invoiceSchema.index({ currency: 1 });

export default invoiceSchema;
