import mongoose from "mongoose";

const dealNoteSchema = new mongoose.Schema(
  {
    dealId:    { type: mongoose.Schema.Types.ObjectId, ref: "Deal", required: true, index: true },
    text:      { type: String, required: true, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

export default mongoose.model("DealNote", dealNoteSchema);
