import mongoose from "mongoose";

const indiaMartIntegrationSchema = new mongoose.Schema(
  {
    tenantId:    { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    connectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    companyName: { type: String, default: "" },
    apiKey:      { type: String, required: true }, // Encrypted
    status:      { type: String, enum: ["active", "inactive"], default: "active" },
    lastSyncAt:  { type: Date, default: null },
  },
  { timestamps: true }
);

export default indiaMartIntegrationSchema;
