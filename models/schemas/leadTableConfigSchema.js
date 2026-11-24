import mongoose from "mongoose";

// One document per tenant: the Leads table column layout the Admin chose on
// the Leads page. Shown to every user. Array order = column order; empty =
// use the defaults in utils/leadTableColumns.js.
const leadTableConfigSchema = new mongoose.Schema(
  {
    columns: [
      {
        _id:     false,
        key:     { type: String, required: true },
        visible: { type: Boolean, default: true },
      },
    ],
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

export default leadTableConfigSchema;
