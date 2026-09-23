import mongoose from "mongoose";

// One custom field definition inside a category's field builder (the prototype's
// "fieldbuilder-row") — label/type always required, options only meaningful for Dropdown.
const assetFieldDefSchema = new mongoose.Schema(
  {
    label:   { type: String, required: true, trim: true },
    type:    { type: String, enum: ["Text", "Number", "Date", "Dropdown", "Currency"], default: "Text" },
    options: { type: [String], default: undefined }, // only set when type === "Dropdown"
  },
  { _id: true }
);

const assetCategorySchema = new mongoose.Schema(
  {
    name:  { type: String, required: true, trim: true },
    icon:  { type: String, default: "📦" },
    color: { type: String, default: "#22415F" },
    // Fully tenant-editable field builder — everything here is optional/dynamic.
    // Name, Status and Assigned To are core Asset fields, never part of this list.
    fields: { type: [assetFieldDefSchema], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

export default assetCategorySchema;
