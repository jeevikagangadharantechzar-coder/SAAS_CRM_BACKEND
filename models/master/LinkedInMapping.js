import mongoose from "mongoose";
import { masterConn } from "../../config/masterDB.js";

const linkedinMappingSchema = new mongoose.Schema(
  {
    tenantId:        { type: mongoose.Schema.Types.ObjectId, required: true },
    dbName:          { type: String, required: true },
    integrationId:   { type: mongoose.Schema.Types.ObjectId, required: true },
    leadFormUrn:     { type: String, required: true, unique: true, index: true },
    organizationUrn: { type: String, index: true },
    adAccountUrn:    { type: String, index: true },
  },
  { timestamps: true }
);

const LinkedInMapping = masterConn.model("LinkedInMapping", linkedinMappingSchema);
export default LinkedInMapping;
