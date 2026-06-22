import mongoose from "mongoose";

const emailTemplateSchema = new mongoose.Schema(
  {
    title:     { type: String, required: true },
    subject:   { type: String, required: true },
    content:   { type: String, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

export default emailTemplateSchema;
