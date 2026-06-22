import mongoose from "mongoose";

const pricingRiskSchema = new mongoose.Schema({
  dealId: { type: mongoose.Schema.Types.ObjectId, ref: "Deal", required: true, unique: true },
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Deal", required: true, index: true },
  companyName: { type: String, required: true, index: true },
  dealName: { type: String, required: true },
  dealValue: { type: Number, required: true },
  discountGiven: { type: Number, default: 0 },
  salespersonId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  salespersonName: { type: String },
  
  // Risk assessment
  riskLevel: { type: String, enum: ["Low", "Medium", "High"], default: "Low" },
  riskFactors: [{ type: String }],
  
  // Pricing recommendation
  recommendedDiscount: { type: Number, default: 0 },
  suggestedMinPrice: { type: Number },
  suggestedMaxPrice: { type: Number },
  confidenceScore: { type: Number, min: 0, max: 100 },
  
  // Client quality metrics (for recommendation)
  clientProgress: { type: String, enum: ["Excellent", "Good", "Average", "Poor"] },
  supportTickets: { type: Number, default: 0 },
  positiveReply: { type: Boolean, default: false },
  
  // Metadata
  detectedAt: { type: Date, default: Date.now },
  resolvedAt: { type: Date },
  status: { type: String, enum: ["Active", "Resolved", "Ignored"], default: "Active" }
}, { timestamps: true });

pricingRiskSchema.index({ companyId: 1, status: 1 });
pricingRiskSchema.index({ riskLevel: 1 });
pricingRiskSchema.index({ detectedAt: -1 });

const PricingRisk = mongoose.model("PricingRisk", pricingRiskSchema);
export default PricingRisk;