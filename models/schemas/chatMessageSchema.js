import mongoose from "mongoose";

const chatMessageSchema = new mongoose.Schema(
  {
    senderId:   { type: mongoose.Schema.Types.ObjectId, required: true },
    receiverId: { type: mongoose.Schema.Types.ObjectId, required: true },
    senderName: { type: String, default: "" },
    senderRole: { type: String, default: "user" },
    message:    { type: String, default: "" },
    fileUrl:    { type: String, default: null },
    fileName:   { type: String, default: null },
    fileType:   { type: String, default: null }, // 'image' | 'document'
    isRead:     { type: Boolean, default: false },
    readAt:     { type: Date, default: null },
    isPinned:   { type: Boolean, default: false },
    isDeleted:  { type: Boolean, default: false },
    reactions:  [{ userId: { type: mongoose.Schema.Types.ObjectId }, emoji: String }],
    replyTo: {
      messageId:  { type: mongoose.Schema.Types.ObjectId, default: null },
      message:    { type: String, default: "" },
      senderName: { type: String, default: "" },
    },
  },
  { timestamps: true }
);

chatMessageSchema.index({ senderId: 1, receiverId: 1, createdAt: -1 });
chatMessageSchema.index({ receiverId: 1, isRead: 1 });

export default chatMessageSchema;
