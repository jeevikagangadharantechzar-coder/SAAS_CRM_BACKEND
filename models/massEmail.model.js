import mongoose from "mongoose";

const massEmailSchema = new mongoose.Schema(
  {
    recipients: [
      {
        type: String,
        required: true,
      },
    ],
    templateTitle: {
      type: String,
      default: null,
    },
    subject: {
      type: String,
      required: true,
    },
    content: {
      type: String,
      required: true,
    },
    attachments: [
      {
        filename: String,
        path: String,
      },
    ],
    scheduledFor: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ["pending", "scheduled", "processing", "sent", "failed"],
      default: "pending",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    

  },
  { timestamps: true }
);

const MassEmail = mongoose.model("MassEmail", massEmailSchema);

export default MassEmail;
