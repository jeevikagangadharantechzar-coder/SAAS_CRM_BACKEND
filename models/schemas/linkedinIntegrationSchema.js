import mongoose from "mongoose";

const linkedinIntegrationSchema = new mongoose.Schema(
  {
    tenantId:         { type: mongoose.Schema.Types.ObjectId, required: true },
    linkedinMemberId: { type: String, default: "" },

    organizationUrn:  { type: String, default: "" },
    organizationName: { type: String, default: "" },

    adAccountUrn:     { type: String, default: "" },
    adAccountName:    { type: String, default: "" },

    leadFormUrn:      { type: String, default: "" },
    leadFormName:     { type: String, default: "" },

    accessToken:      { type: String, required: true },
    refreshToken:     { type: String, default: "" },
    expiresAt:        { type: Date, default: null },

    webhookSubscribed: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ["active", "disconnected"],
      default: "active",
    },
    connectedBy:      { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

linkedinIntegrationSchema.index({ tenantId: 1 });
linkedinIntegrationSchema.index({ organizationUrn: 1 });
linkedinIntegrationSchema.index({ adAccountUrn: 1 });
linkedinIntegrationSchema.index({ leadFormUrn: 1 });

export default linkedinIntegrationSchema;
