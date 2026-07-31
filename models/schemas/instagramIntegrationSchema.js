import mongoose from "mongoose";

const InstagramIntegrationSchema = new mongoose.Schema(
  {
    igAccountId:       { type: String, required: true },   // Instagram Business Account ID
    pageId:            { type: String, required: true },   // Linked Facebook Page ID
    username:          { type: String, default: "" },      // @handle
    displayName:       { type: String, default: "" },      // Business display name
    profilePictureUrl: { type: String, default: "" },

    // Long-lived user token (~60 days) — used for IG Graph API calls
    accessToken:    { type: String, required: true },
    tokenExpiresAt: { type: Date, default: null },

    // Page access token — perpetual, used as fallback & for webhook subscription
    pageAccessToken: { type: String, default: "" },

    status:            { type: String, enum: ["active", "disconnected"], default: "active" },
    webhookSubscribed: { type: Boolean, default: false },
    connectedBy:       { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

InstagramIntegrationSchema.index({ igAccountId: 1 });
InstagramIntegrationSchema.index({ status: 1 });

export default InstagramIntegrationSchema;
