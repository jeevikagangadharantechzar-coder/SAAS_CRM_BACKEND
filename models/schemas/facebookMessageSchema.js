import mongoose from "mongoose";

const FacebookMessageSchema = new mongoose.Schema(
  {
    pageId:    { type: String, required: true, index: true },
    messageId: { type: String, sparse: true },

    senderPsid:      { type: String, required: true, index: true },
    senderName:      { type: String, default: "" },
    senderProfilePic:{ type: String, default: "" },

    direction: { type: String, enum: ["inbound", "outbound"], required: true },

    type: {
      type: String,
      enum: ["text", "image", "video", "audio", "file", "unsupported"],
      default: "text",
    },

    body:     { type: String, default: "" },
    mediaUrl: { type: String, default: null },

    status: {
      type: String,
      enum: ["pending", "sent", "delivered", "seen", "failed"],
      default: "pending",
    },
    statusUpdatedAt: { type: Date, default: null },

    read:   { type: Boolean, default: false },
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", default: null },

    fbTimestamp: { type: Date, default: null },
  },
  { timestamps: true }
);

FacebookMessageSchema.index({ pageId: 1, senderPsid: 1, createdAt: -1 });
FacebookMessageSchema.index({ messageId: 1 }, { sparse: true });

export default FacebookMessageSchema;
