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
  },
  { timestamps: true }
);

const Settings = mongoose.model("Settings", settingsSchema);

export default Settings;