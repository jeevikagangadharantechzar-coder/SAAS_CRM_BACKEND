import mongoose from "mongoose";

const InstagramCommentSchema = new mongoose.Schema(
  {
    igAccountId:     { type: String, required: true, index: true },
    postId:          { type: String, required: true, index: true }, // IG media ID
    postCaption:     { type: String, default: "" },
    postMediaUrl:    { type: String, default: "" },
    postMediaType:   { type: String, default: "IMAGE" }, // IMAGE | VIDEO | CAROUSEL_ALBUM

    commentId:       { type: String, required: true, unique: true },
    parentCommentId: { type: String, default: null }, // null = top-level comment

    senderUsername:  { type: String, default: "" },
    senderIgsid:     { type: String, default: "" },
    text:            { type: String, default: "" },

    isHidden:  { type: Boolean, default: false },
    isDeleted: { type: Boolean, default: false },
    replied:   { type: Boolean, default: false },
    replyText: { type: String, default: "" },

    isAd:  { type: Boolean, default: false },
    adId:  { type: String, default: null },

    leadId:  { type: mongoose.Schema.Types.ObjectId, ref: "Lead", default: null },
    igTimestamp: { type: Date, default: null },
  },
  { timestamps: true }
);

InstagramCommentSchema.index({ igAccountId: 1, createdAt: -1 });

export default InstagramCommentSchema;
