import mongoose from "mongoose";

const aiChatSchema = new mongoose.Schema(
  {
    userId:      { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    message:     { type: String, required: true },
    intent:      { type: String, default: "unknown" },
    response:    { type: String },
    resultCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export default aiChatSchema;
