import mongoose from "mongoose";
import dotenv from "dotenv";
import { masterConn } from "../config/masterDB.js";
import Tenant from "../models/master/Tenant.js";

dotenv.config();

const inlineLeadSchema = new mongoose.Schema({
  leadName:    { type: String, required: true },
  phoneNumber: { type: String, required: true },
  email:       { type: String },
  source:      { type: String },
  companyName: { type: String, required: true },
  clientType:  { type: String },
  status:      { type: String },
  notes:       { type: String },
  linkedinLeadId:       { type: String },
  linkedinFormId:       { type: String },
  linkedinFormName:     { type: String },
  linkedinCampaignId:   { type: String },
  linkedinCampaignName: { type: String },
}, { timestamps: true, strict: false });

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error("Usage: node scripts/test-linkedin-lead.js <tenantSlug>");
    process.exit(1);
  }

  await masterConn.asPromise();
  const tenant = await Tenant.findOne({ slug });

  if (!tenant) {
    console.error(`Tenant with slug "${slug}" not found.`);
    process.exit(1);
  }

  console.log(`Found tenant: ${tenant.name} -> DB: ${tenant.dbName}`);

  const oldMongoUrl = process.env.MONGO_URL;
  let baseUri = process.env.MONGO_BASE_URI || oldMongoUrl.replace(/\/[^/]*(\?.*)?$/, "");
  baseUri = baseUri.replace(/\/+$/, "");
  const tenantConn = await mongoose.createConnection(`${baseUri}/${tenant.dbName}`).asPromise();

  // Use the inline schema to prevent circular dependency imports
  const Lead = tenantConn.model("Lead", inlineLeadSchema, "leads");

  const testLead = await Lead.create({
    leadName: "John Doe (LinkedIn Test)",
    phoneNumber: "+1 555-0199",
    email: "johndoe.test@example.com",
    source: "LinkedIn",
    companyName: "Acme Corp",
    clientType: "B2B",
    industry: "Technology",
    requirement: "CRM Integration solutions",
    status: "Cold",
    notes: "Directly inserted via test-linkedin-lead script to simulate lead capture.",
    linkedinLeadId: `test_li_id_${Date.now()}`,
    linkedinFormId: "urn:li:adForm:1016970021",
    linkedinFormName: "CRM SaaS Test Form",
    linkedinCampaignId: "urn:li:adCampaign:29481029",
    linkedinCampaignName: "LinkedIn SaaS Campaign",
  });

  console.log(`\nSuccess! Created test Lead in ${tenant.dbName}:`);
  console.log(JSON.stringify(testLead, null, 2));

  await tenantConn.close();
  await masterConn.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
