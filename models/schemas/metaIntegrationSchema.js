import mongoose from "mongoose";

const metaIntegrationSchema = new mongoose.Schema(
  {
    // Facebook Page details
    facebookPageId:     { type: String, required: true },
    pageName:           { type: String, default: "" },
    pageAccessToken:    { type: String, required: true },
    tokenExpiry:        { type: Date, default: null },       // null = long-lived (no expiry)

    // Linked Instagram Business Account (auto-fetched if page has IG linked)
    instagramAccountId: { type: String, default: null },
    instagramUsername:  { type: String, default: "" },

    // Connection state
    status:             { type: String, enum: ["active", "disconnected"], default: "active" },
    webhookSubscribed:  { type: Boolean, default: false },

    // Who connected it
    connectedBy:        { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

export default metaIntegrationSchema;
