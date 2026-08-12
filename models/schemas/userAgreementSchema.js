import mongoose from "mongoose";

const userAgreementSchema = new mongoose.Schema(
  {
    user:          { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    agreementType: { type: String, enum: ["privacy_policy", "terms_conditions"], required: true },
    acceptedAt:    { type: Date, required: true, default: Date.now },
    ipAddress:     String,
  },
  { timestamps: true }
);

userAgreementSchema.index({ user: 1, agreementType: 1 });

export default userAgreementSchema;
