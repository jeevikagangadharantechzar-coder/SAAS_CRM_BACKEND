import mongoose from "mongoose";

const groupSchema = new mongoose.Schema(
  {
    name:        { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    avatar:      { type: String, default: null },
    createdBy:   { type: mongoose.Schema.Types.ObjectId, required: true },
    members:              [{ type: mongoose.Schema.Types.ObjectId }],
    admins:               [{ type: mongoose.Schema.Types.ObjectId }],
    onlyAdminsCanMessage: { type: Boolean, default: false },
  },
  { timestamps: true }
);

groupSchema.index({ members: 1 });

export default groupSchema;
