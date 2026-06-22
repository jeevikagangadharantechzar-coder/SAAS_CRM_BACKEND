import mongoose from "mongoose";
import { masterConn } from "../../config/masterDB.js";

const superAdminSchema = new mongoose.Schema(
  {
    name:     { type: String, required: true, trim: true },
    email:    { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
  },
  { timestamps: true }
);

const SuperAdmin = masterConn.model("SuperAdmin", superAdminSchema);
export default SuperAdmin;
