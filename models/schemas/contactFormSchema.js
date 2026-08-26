import mongoose from "mongoose";

const contactFormSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
    },

    // Business info
    companyName: {
      type: String,
      trim: true,
    },

    industry: {
      type: String,
      trim: true,
    },

    address: {
      type: String,
      trim: true,
    },

    country: {
      type: String,
      trim: true,
    },

    source: {
      type: String,
      default: "Website",
      trim: true,
    },

    clientType: { 
      type: String,
      enum: ["B2B", "B2C"],
      trim: true,
    },

    requirement: {
      type: String,
      trim: true,
    },

    notes: {
      type: String,
      trim: true,
    },
    attachments: [
      {
        name: { type: String },
        path: { type: String },
        type: { type: String },
        size: { type: Number },
        uploadedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],

    // Fields a tenant's own contact form sends that don't match any of the
    // known columns above (each tenant's website form has its own field
    // set). Captured as-is so nothing submitted is silently dropped.
    customFields: [
      {
        name:  { type: String, required: true },
        value: { type: String, default: "" },
      },
    ],

  },
  { timestamps: true }
);

export default contactFormSchema;
