import mongoose from "mongoose";
import { masterConn } from "../../config/masterDB.js";

// Standalone collection for enquiries submitted through the public marketing
// site's Software Enquiry form (D:\Techzarinfo-site). Lives in the master DB,
// independent of any tenant, and is only ever read/managed from the SuperAdmin
// panel's "Social Media Leads" screen — kept separate from the tenant Lead
// model on purpose.
const softwareEnquirySchema = new mongoose.Schema(
  {
    name:        { type: String, required: true, trim: true },
    phone:       { type: String, required: true, trim: true },
    email:       { type: String, required: true, lowercase: true, trim: true },
    projectType: { type: String, required: true, trim: true },
    startTime:   { type: String, trim: true, default: "" },
    budget:      { type: String, trim: true, default: "" },
    marketing:   { type: String, trim: true, default: "" },

    source: { type: String, default: "Social Media" },
    status: {
      type: String,
      enum: ["New", "Contacted", "Converted", "Rejected"],
      default: "New",
    },
  },
  { timestamps: true }
);

softwareEnquirySchema.index({ createdAt: -1 });

const SoftwareEnquiry = masterConn.model("SoftwareEnquiry", softwareEnquirySchema);
export default SoftwareEnquiry;
