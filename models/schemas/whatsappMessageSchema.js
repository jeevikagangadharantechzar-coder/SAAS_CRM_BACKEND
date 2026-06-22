import mongoose from "mongoose";

const WhatsappMessageSchema = new mongoose.Schema(
  {
    contactNumber: { type: String, required: true, trim: true },
    contactName:   { type: String, default: "", trim: true },
    direction: {
      type: String,
      enum: ["inbound", "outbound"],
      required: true,
    },
    body:       { type: String, default: "" },
    messageSid: { type: String, default: "" },
    status:     { type: String, default: "sent" },
    mediaUrls:  [{ type: String }],
    read:       { type: Boolean, default: false },
    crmContactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Contact",
      default: null,
    },
    sentBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

WhatsappMessageSchema.index({ contactNumber: 1, createdAt: 1 });
WhatsappMessageSchema.index({ read: 1, direction: 1 });

export default WhatsappMessageSchema;
