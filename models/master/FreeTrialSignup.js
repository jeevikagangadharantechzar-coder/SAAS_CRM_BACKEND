import mongoose from "mongoose";
import { masterConn } from "../../config/masterDB.js";

const freeTrialSignupSchema = new mongoose.Schema(
  {
    name:                { type: String, required: true, trim: true },
    email:               { type: String, required: true, lowercase: true, trim: true },
    businessName:        { type: String, required: true, trim: true },
    industry:            { type: String, default: "" },
    country:             { type: String, default: "" },
    subscriptionPackage: { type: String, default: "" },
    tenant:              { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    slug:                { type: String, required: true },
  },
  { timestamps: true }
);

const FreeTrialSignup = masterConn.model("FreeTrialSignup", freeTrialSignupSchema);
export default FreeTrialSignup;
