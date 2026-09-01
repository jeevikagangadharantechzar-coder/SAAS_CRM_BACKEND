import mongoose from "mongoose";
import { masterConn } from "../../config/masterDB.js";

const superAdminSchema = new mongoose.Schema(
  {
    name:     { type: String, required: true, trim: true },
    email:    { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    
    // MFA Fields
    mfaSecret: { type: String },
    isMfaEnabled: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const SuperAdmin = masterConn.model("SuperAdmin", superAdminSchema);
export default SuperAdmin;
