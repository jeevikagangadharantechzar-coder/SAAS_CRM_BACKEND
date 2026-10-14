import mongoose from "mongoose";

const catalogCategorySchema = new mongoose.Schema(
  {
    name:        { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },
    color:       { type: String, default: "#22415F" },
    icon:        { type: String, default: "📦" },
    isActive:    { type: Boolean, default: true },
    createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy:   { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

catalogCategorySchema.index({ name: 1 }, { unique: true });
catalogCategorySchema.index({ isActive: 1 });

export default catalogCategorySchema;
