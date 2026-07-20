import mongoose from "mongoose";

const invoiceSchema = new mongoose.Schema({
  invoicenumber: {
    type: String,
    required: true,
    unique: true,
    default: () => `TZI-${Math.floor(Math.random() * 1000000)}`,
  },
  assignTo: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  lastUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  issueDate: { type: Date, required: true },
  dueDate: { type: Date, required: true },
  status: { type: String, enum: ["paid", "unpaid", "partially_paid"], required: true },
  // Cumulative amount actually collected so far (grows as partial payments come in)
  amountPaid: { type: Number, default: 0 },
  statusHistory: [
    {
      status:     { type: String, enum: ["paid", "unpaid", "partially_paid"] },
      amountPaid: { type: Number },
      changedAt:  { type: Date, default: Date.now },
      changedBy:  { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    },
  ],

  items: [
    {
      deal: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: "Deal", 
        required: true 
      },
      price: { type: Number, required: true },
      amount: { type: Number, required: true }, // price itself or pre-calculated
    },
  ],

  note: { type: String },

  // Store calculated amounts
  subtotal: { type: Number, required: true },
  discount: { type: Number, default: 0 }, // actual discount amount
  tax: { type: Number, default: 0 },      // actual tax amount
  total: { type: String, required: true },

  // Store original input values
  discountValue: { type: Number, default: 0 }, // percentage or fixed
  discountType: { type: String, enum: ["percentage","fixed"], default: "percentage" },
  taxValue: { type: Number, default: 0 }, // percentage or fixed
  taxType: { type: String, enum: ["percentage","fixed"], default: "percentage" },

  currency: { type: String, default: "USD" },
  // INR CONVERSION
  paidAt: {
    type: Date,
    default: null
  },
  emailSentAt: {
    type: Date,
    default: null
  },
  inrAmount: { 
    type: Number, 
    default: null 
  },
  exchangeRate: {
    type: Number,
    default: null
  },
  preferredCurrency:      { type: String, default: null },
  preferredCurrencyValue: { type: Number, default: null },

  billingAddress: { type: String, default: "" },
  clientTaxId:    { type: String, default: "" },
  poNumber:       { type: String, default: "" },
  customFields: [
    {
      label: { type: String, required: true },
      type:  { type: String, enum: ["text", "number", "date"], default: "text" },
      value: { type: String, default: "" },
    },
  ],

}, { timestamps: true });

//  index for better query performance
invoiceSchema.index({ paidAt: 1 });
invoiceSchema.index({ status: 1 });
invoiceSchema.index({ currency: 1 });

const Invoice = mongoose.model("Invoice", invoiceSchema);
export default Invoice;
