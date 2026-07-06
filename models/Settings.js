import mongoose from "mongoose";

const settingsSchema = new mongoose.Schema(
  {
    companyName: {
      type: String,
      default: "My Company",
    },
    logo: {
      type: String,
      default: null,
    },
    favicon: {               
      type: String,
      default: null,
    },
    invoiceLogo: {
      type: String,
      default: null,
    },

    address:     { type: String, default: "" },
    phone:       { type: String, default: "" },
    email:       { type: String, default: "" },
    taxIdLabel:  { type: String, default: "Tax ID" },
    taxId:       { type: String, default: "" },

    bankDetails: {
      accountName:   { type: String, default: "" },
      accountNumber: { type: String, default: "" },
      bankName:      { type: String, default: "" },
      ifscOrSwift:   { type: String, default: "" },
      branch:        { type: String, default: "" },
    },

    termsAndConditions: { type: String, default: "Payment due within 30 days." },

    invoiceSenderEmail: { type: String, default: null },
  },
  { timestamps: true }
);

const Settings = mongoose.model("Settings", settingsSchema);

export default Settings;