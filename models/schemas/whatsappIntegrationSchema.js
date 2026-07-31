import mongoose from "mongoose";

const WhatsAppIntegrationSchema = new mongoose.Schema(
  {
    wabaId:            { type: String, required: true },   // WhatsApp Business Account ID
    phoneNumberId:     { type: String, required: true },   // Meta phone number ID (used for sending)
    phoneNumber:       { type: String, required: true },   // display e.g. "+91 98765 43210"
    displayName:       { type: String, default: "" },      // business name shown to customers
    accessToken:       { type: String, required: true },   // long-lived user / system-user token
    tokenExpiresAt:    { type: Date,   default: null },    // null = never (system user token)
    status:            { type: String, enum: ["active", "disconnected"], default: "active" },
    webhookSubscribed: { type: Boolean, default: false },
    connectedBy:       { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

WhatsAppIntegrationSchema.index({ phoneNumberId: 1 });
WhatsAppIntegrationSchema.index({ wabaId: 1 });
WhatsAppIntegrationSchema.index({ status: 1 });

export default WhatsAppIntegrationSchema;
