import mongoose from "mongoose";

const WhatsappConversationSchema = new mongoose.Schema(
  {
    // Unique contact number (whatsapp:+91XXXXXXXXXX)
    contactNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    // Human-friendly name (editable from CRM)
    contactName: {
      type: String,
      default: "",
      trim: true,
    },

    // Snapshot of the last message for conversation list preview
    lastMessage: {
      type: String,
      default: "",
    },

    lastMessageAt: {
      type: Date,
      default: Date.now,
    },

    lastMessageDirection: {
      type: String,
      enum: ["inbound", "outbound"],
      default: "inbound",
    },

    // Count of unread inbound messages
    unreadCount: {
      type: Number,
      default: 0,
    },

    // Linked CRM contact
    crmContactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Contact",
      default: null,
    },

    // Assigned agent
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    isArchived: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

WhatsappConversationSchema.index({ lastMessageAt: -1 });
WhatsappConversationSchema.index({ unreadCount: -1 });

const WhatsappConversation = mongoose.model(
  "WhatsappConversation",
  WhatsappConversationSchema
);
export default WhatsappConversation;

