import mongoose from "mongoose";

const renewalSchema = new mongoose.Schema(
  {
    dealId: { type: mongoose.Schema.Types.ObjectId, ref: "Deal", required: true },
    companyName: { type: String, required: true, index: true },
    renewalDate: { type: Date, required: true },
    renewalValue: { type: Number, required: true },
    currency: { type: String, default: "INR" },
    status: {
      type: String,
      enum: ["Pending", "Approved", "Completed", "Lost"],
      default: "Pending",
    },
    renewalProbability: { type: Number, default: 50, min: 0, max: 100 },
    notes: String,
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    completedAt: Date,
  },
  { timestamps: true }
);

renewalSchema.index({ companyName: 1, status: 1 });

const Renewal = mongoose.model("Renewal", renewalSchema);
export default Renewal;