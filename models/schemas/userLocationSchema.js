import mongoose from "mongoose";

// One document per user — always overwritten with the latest reported
// position, not a history log. Live tracking is pushed to Admins over the
// socket as it updates; this doc backs the initial map load / page refresh.
const userLocationSchema = new mongoose.Schema(
  {
    userId:    { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    latitude:  { type: Number, required: true },
    longitude: { type: Number, required: true },
    accuracy:  { type: Number, default: null },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

export default userLocationSchema;
