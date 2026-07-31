import mongoose from "mongoose";

const InstagramMessageSchema = new mongoose.Schema(
  {
    igAccountId:    { type: String, required: true, index: true }, // our IG account
    conversationId: { type: String, index: true },                 // IG conversation ID
    messageId:      { type: String, sparse: true },                // IG message ID (dedup)

    // The person on the other side
    senderIgsid:      { type: String, required: true, index: true }, // Instagram Scoped ID
    senderUsername:   { type: String, default: "" },
    senderName:       { type: String, default: "" },
    senderProfilePic: { type: String, default: "" },

    direction: { type: String, enum: ["inbound", "outbound"], required: true },

    type: {
      type: String,
      enum: ["text", "image", "video", "audio", "file", "story_mention", "story_reply",
             "reel", "ig_reel", "ig_post", "reaction", "unsupported", "deleted"],
      default: "text",
    },

    body:          { type: String, default: "" },
    mediaUrl:      { type: String, default: null },
    mediaId:       { type: String, default: null },
    mediaMimeType: { type: String, default: null },
    mediaFilename: { type: String, default: null },

    // Story mention — the story that mentioned us
    storyUrl:      { type: String, default: null },
    storyId:       { type: String, default: null },

    // Reaction (when someone reacts to our message)
    reactionEmoji: { type: String, default: null },
    reactionTargetMessageId: { type: String, default: null },

    status: {
      type: String,
      enum: ["pending", "sent", "delivered", "seen", "failed"],
      default: "pending",
    },
    statusUpdatedAt: { type: Date, default: null },

    read:   { type: Boolean, default: false },
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", default: null },

    igTimestamp: { type: Date, default: null }, // original IG timestamp
  },
  { timestamps: true }
);

InstagramMessageSchema.index({ igAccountId: 1, senderIgsid: 1, createdAt: -1 });
InstagramMessageSchema.index({ messageId: 1 }, { sparse: true });

export default InstagramMessageSchema;
