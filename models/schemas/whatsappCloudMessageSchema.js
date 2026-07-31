import mongoose from "mongoose";

const WhatsAppCloudMessageSchema = new mongoose.Schema(
  {
    // which integration/phone-number sent or received this message
    phoneNumberId:  { type: String, required: true, index: true },

    // WhatsApp message ID from Meta — sparse so outbound gets one after confirmation
    waMessageId:    { type: String, sparse: true },

    // contact on the other side
    contactWaId:   { type: String, required: true, index: true }, // e.g. "919876543210"
    contactName:   { type: String, default: "" },

    direction:     { type: String, enum: ["inbound", "outbound"], required: true },

    // message type
    type: {
      type: String,
      enum: ["text", "image", "audio", "video", "document", "sticker", "location", "button", "reaction", "contacts", "unknown"],
      default: "text",
    },

    // text body (also used for captions on media)
    body: { type: String, default: "" },

    // media (filled for image/audio/video/document/sticker)
    mediaId:       { type: String, default: null },  // Meta media ID to download
    mediaUrl:      { type: String, default: null },  // CDN/proxied URL after download
    mediaMimeType: { type: String, default: null },
    mediaFilename: { type: String, default: null },  // document filename

    // location
    location: {
      latitude:  Number,
      longitude: Number,
      name:      String,
      address:   String,
    },

    // reaction
    reaction: {
      messageId: String,  // the message being reacted to
      emoji:     String,
    },

    // delivery / read status (outbound)
    status: {
      type: String,
      enum: ["pending", "sent", "delivered", "read", "failed"],
      default: "pending",
    },
    statusUpdatedAt: { type: Date, default: null },

    // has the CRM agent seen this (inbound)
    read:   { type: Boolean, default: false },

    // outbound only — CRM user who sent it
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    // optional link to a CRM lead
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", default: null },

    // original WhatsApp timestamp (from Meta payload)
    whatsappTimestamp: { type: Date, default: null },
  },
  { timestamps: true }
);

WhatsAppCloudMessageSchema.index({ phoneNumberId: 1, contactWaId: 1, createdAt: -1 });
WhatsAppCloudMessageSchema.index({ waMessageId: 1 }, { sparse: true });

export default WhatsAppCloudMessageSchema;
