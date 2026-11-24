import mongoose from "mongoose";
import leadTableConfigSchema from "./schemas/leadTableConfigSchema.js";

// Legacy (non-tenant) fallback — tenants use getTenantModels().LeadTableConfig
const LeadTableConfig = mongoose.models.LeadTableConfig || mongoose.model("LeadTableConfig", leadTableConfigSchema);

export default LeadTableConfig;
