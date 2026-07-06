import mongoose from "mongoose";

const zoomIntegrationSchema = new mongoose.Schema(
  {
    clientId:     { type: String, required: true, trim: true },
    clientSecret: { type: String, required: true }, // stored encrypted, see utils/crypto.js
    accountId:    { type: String, required: true, trim: true },
    hostUserId:   { type: String, required: true, trim: true },
    connectedBy:  { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

export default zoomIntegrationSchema;
