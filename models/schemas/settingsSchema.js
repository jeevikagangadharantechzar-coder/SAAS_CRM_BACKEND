import mongoose from "mongoose";

const settingsSchema = new mongoose.Schema(
  {
    companyName: { type: String, default: "My Company" },
    logo:        { type: String, default: null },
    favicon:     { type: String, default: null },
    invoiceLogo: { type: String, default: null },

    // Business details shown on invoices — varies by country (address format, tax ID type)
    address:     { type: String, default: "" },
    phone:       { type: String, default: "" },
    email:       { type: String, default: "" },
    taxIdLabel:  { type: String, default: "Tax ID" }, // e.g. "GSTIN", "VAT No.", "EIN"
    taxId:       { type: String, default: "" },

    bankDetails: {
      accountName:   { type: String, default: "" },
      accountNumber: { type: String, default: "" },
      bankName:      { type: String, default: "" },
      ifscOrSwift:   { type: String, default: "" },
      branch:        { type: String, default: "" },
    },

    termsAndConditions: { type: String, default: "Payment due within 30 days." },

    // Gmail account connected via OAuth for sending invoices as this tenant.
    // Tokens themselves live in the (global) GmailToken collection, keyed by this email.
    invoiceSenderEmail: { type: String, default: null },
  },
  { timestamps: true }
);

export default settingsSchema;
