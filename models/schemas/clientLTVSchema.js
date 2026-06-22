import mongoose from "mongoose";

const clientLTVSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Deal",
      required: true,
      unique: true,
      index: true,
    },
    companyName: { type: String, required: true, index: true },
    classification: {
      type: String,
      enum: ["Upsell", "Top Value", "At Risk", "Dormant", "Active"],
      default: "Active",
      index: true,
    },
    classificationReason:    { type: String, default: "" },
    classificationUpdatedAt: { type: Date, default: Date.now },

    valueCategory: {
      type: String,
      enum: ["High Value", "Medium Value", "Low Value"],
      default: "Low Value",
    },

    totalRevenue:       { type: Number, default: 0 },
    averageDealValue:   { type: Number, default: 0 },
    totalDeals:         { type: Number, default: 0 },
    closedWonDeals:     { type: Number, default: 0 },
    repeatPurchaseRate: { type: Number, default: 0 },

    upsellRevenue:      { type: Number, default: 0 },
    upsellCount:        { type: Number, default: 0 },
    upsellOpportunity:  { type: Boolean, default: false, index: true },
    upsellReason:       { type: String },

    totalSupportTickets: { type: Number, default: 0 },
    openSupportTickets:  { type: Number, default: 0 },
    lastSupportDate:     { type: Date },
    supportPoints:       { type: Number, default: 0 },

    followUpCount:     { type: Number, default: 0 },
    lastFollowUpDate:  { type: Date },
    daysSinceFollowUp: { type: Number, default: 365, index: true },

    hasReview:    { type: Boolean, default: false, index: true },
    latestReview: { type: mongoose.Schema.Types.ObjectId, ref: "ClientReview" },
    progress: {
      type: String,
      enum: ["Excellent", "Good", "Average", "Poor", null],
      default: null,
    },
    positiveReply: { type: Boolean, default: false },

    riskScore:   { type: Number, default: 0, min: 0, max: 100, index: true },
    riskFactors: [{ type: String }],

    customerLifetimeValue: { type: Number, default: 0, index: true },
    projectedCLV:          { type: Number, default: 0 },

    clientHealthScore: { type: Number, default: 50, min: 0, max: 100 },

    delivered: { type: Boolean, default: false },

    suggestedMinPrice:    { type: Number },
    suggestedMaxPrice:    { type: Number },
    recommendedDiscount:  { type: Number, default: 0 },

    firstDealDate:           { type: Date },
    lastDealDate:            { type: Date },
    lastActivityDate:        { type: Date },
    lastClassificationUpdate:{ type: Date, default: Date.now },

    monthlyRevenue: [
      {
        month:   String,
        year:    Number,
        revenue: Number,
      },
    ],
    revenueGrowth: { type: Number, default: 0 },

    pricingRecommendation: {
      suggestedMinPrice:  Number,
      suggestedMaxPrice:  Number,
      recommendedDiscount:Number,
      confidenceScore:    Number,
      calculatedAt:       Date,
    },
  },
  { timestamps: true }
);

clientLTVSchema.index({ classification: 1, customerLifetimeValue: -1 });
clientLTVSchema.index({ riskScore: -1, daysSinceFollowUp: -1 });
clientLTVSchema.index({ upsellOpportunity: 1, customerLifetimeValue: -1 });
clientLTVSchema.index({ hasReview: 1, classification: 1 });

export default clientLTVSchema;
