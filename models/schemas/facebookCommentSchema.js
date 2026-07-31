import mongoose from "mongoose";

const FacebookCommentSchema = new mongoose.Schema(
  {
    pageId:       { type: String, required: true, index: true },
    postId:       { type: String, required: true, index: true },
    postMessage:  { type: String, default: "" },
    postMediaUrl: { type: String, default: "" },

    commentId:       { type: String, required: true, unique: true },
    parentCommentId: { type: String, default: null },

    senderName: { type: String, default: "" },
    senderFbId: { type: String, default: "" },

    text:      { type: String, default: "" },
    isHidden:  { type: Boolean, default: false },
    isDeleted: { type: Boolean, default: false },
    replied:   { type: Boolean, default: false },
    replyText: { type: String, default: "" },

    leadId:      { type: mongoose.Schema.Types.ObjectId, ref: "Lead", default: null },
    fbTimestamp: { type: Date, default: null },
  },
  { timestamps: true }
);

FacebookCommentSchema.index({ pageId: 1, createdAt: -1 });

export default FacebookCommentSchema;
