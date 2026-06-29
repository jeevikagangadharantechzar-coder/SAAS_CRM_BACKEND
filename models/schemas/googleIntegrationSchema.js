import mongoose from "mongoose";

const googleIntegrationSchema = new mongoose.Schema(
  {
    credentials: { type: mongoose.Schema.Types.Mixed, required: true },
    connectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

export default googleIntegrationSchema;
