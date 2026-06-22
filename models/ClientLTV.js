import mongoose from "mongoose";

const clientLTFSchema = new mongoose.Schema(
  {
    companyId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "Deal", 
      required: true, 
      unique: true, 
      index: true 
    },
    companyName: { 
      type: String, 
      required: true, 
      index: true 
    },
    // Classification 
    classification: {
  type: String,
  enum: ["Upsell", "Top Value", "At Risk", "Dormant", "Active"],
  default: "Active",
  index: true
},
    classificationReason: {
      type: String,
      default: ""
    },
    classificationUpdatedAt: {
      type: Date,
      default: Date.now
    },
    
    // Value classification
    valueCategory: {
      type: String,
      enum: ["High Value", "Medium Value", "Low Value"],
      default: "Low Value"
    },
    
    // Deal metrics
    totalRevenue: { type: Number, default: 0 },
    averageDealValue: { type: Number, default: 0 },
    totalDeals: { type: Number, default: 0 },
    closedWonDeals: { type: Number, default: 0 },
    repeatPurchaseRate: { type: Number, default: 0 },
    
    // Upsell metrics
    upsellRevenue: { type: Number, default: 0 },
    upsellCount: { type: Number, default: 0 },
    upsellOpportunity: { type: Boolean, default: false, index: true },
    upsellReason: { type: String },
    
    // Support metrics
    totalSupportTickets: { type: Number, default: 0 },
    openSupportTickets: { type: Number, default: 0 },
    lastSupportDate: { type: Date },
    supportPoints: { type: Number, default: 0 },
    
    // Follow-up metrics
    followUpCount: { type: Number, default: 0 },
    lastFollowUpDate: { type: Date },
    daysSinceFollowUp: { type: Number, default: 365, index: true },
    
    // Review metrics
    hasReview: { type: Boolean, default: false, index: true },
    latestReview: { type: mongoose.Schema.Types.ObjectId, ref: "ClientReview" },
    progress: { 
      type: String, 
      enum: ["Excellent", "Good", "Average", "Poor", null],
      default: null 
    },
    positiveReply: { type: Boolean, default: false },
    
    // Risk metrics
    riskScore: { type: Number, default: 0, min: 0, max: 100, index: true },
    riskFactors: [{ type: String }],
    
    // CLV metrics
    customerLifetimeValue: { type: Number, default: 0, index: true },
    projectedCLV: { type: Number, default: 0 },
    
    // Client health
    clientHealthScore: { type: Number, default: 50, min: 0, max: 100 },

    // Add this after clientHealthScore or with other boolean fields
delivered: {
  type: Boolean,
  default: false
},
    
    // Pricing recommendation
    suggestedMinPrice: { type: Number },
    suggestedMaxPrice: { type: Number },
    recommendedDiscount: { type: Number, default: 0 },
    
    // Dates
    firstDealDate: { type: Date },
    lastDealDate: { type: Date },
    lastActivityDate: { type: Date },
    lastClassificationUpdate: { type: Date, default: Date.now },
    
    // Revenue trends
    monthlyRevenue: [
      {
        month: String,
        year: Number,
        revenue: Number,
      },
    ],
    revenueGrowth: { type: Number, default: 0 },
    
    // Pricing recommendation (cached)
    pricingRecommendation: {
      suggestedMinPrice: Number,
      suggestedMaxPrice: Number,
      recommendedDiscount: Number,
      confidenceScore: Number,
      calculatedAt: Date
    }
  },
  { timestamps: true }
);

// Compound indexes for performance
clientLTFSchema.index({ classification: 1, customerLifetimeValue: -1 });
clientLTFSchema.index({ riskScore: -1, daysSinceFollowUp: -1 });
clientLTFSchema.index({ upsellOpportunity: 1, customerLifetimeValue: -1 });
clientLTFSchema.index({ hasReview: 1, classification: 1 });

const ClientLTV = mongoose.model("ClientLTV", clientLTFSchema);
export default ClientLTV;