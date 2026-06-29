import mongoose from "mongoose";

const groupMessageSchema = new mongoose.Schema(
  {
    groupId:    { type: mongoose.Schema.Types.ObjectId, required: true },
    type:       { type: String, default: "message", enum: ["message", "system"] },
    senderId:   { type: mongoose.Schema.Types.ObjectId, required: true },
    senderName: { type: String, default: "" },
    senderRole: { type: String, default: "user" },
    message:    { type: String, default: "" },
    fileUrl:    { type: String, default: null },
    fileName:   { type: String, default: null },
    fileType:   { type: String, default: null },
    reactions:  [{ userId: { type: mongoose.Schema.Types.ObjectId }, emoji: String }],
    replyTo: {
      messageId:  { type: mongoose.Schema.Types.ObjectId, default: null },
      message:    { type: String, default: "" },
      senderName: { type: String, default: "" },
    },
    isDeleted:  { type: Boolean, default: false },
    readBy:     [{ userId: { type: mongoose.Schema.Types.ObjectId }, readAt: Date }],
  },
  { timestamps: true }
);

groupMessageSchema.index({ groupId: 1, createdAt: -1 });

export default groupMessageSchema;
