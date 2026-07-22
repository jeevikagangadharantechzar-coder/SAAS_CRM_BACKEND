import mongoose from "mongoose";

const dealSchema = new mongoose.Schema({
  leadId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "Lead" 
  },
  dealTitle: { 
    type: String 
  },
  dealName: { 
    type: String, 
    required: true 
  },
  assignedTo: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "User" 
  },
  value: { 
    type: String, 
    required: true 
  },
  currency: { 
    type: String, 
    default: "INR" 
  },
  clientType: {
    type: String,
    enum: ["B2B", "B2C"],
    default: null,
    trim: true,
  },
  discountGiven: {
    type: Number, 
    default: 0,
    min: 0,
    max: 100 
  },
  stage: {
    type: String,
    enum: [
      "Qualification",
      "Proposal Sent-Negotiation",
      "Invoice Sent",
      "Closed Won",
      "Closed Lost",
    ],
    default: "Qualification",
  },
   convertedAt: {
    type: Date,
    default: null
  },
  notes: {
    type: String
  },
  notesUpdatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null
  },
  notesUpdatedAt: {
    type: Date,
    default: null
  },
  phoneNumber: {
    type: String
  },
  email: {
    type: String
  },
  alternativeNumber: {
    type: String
  },
  alternativeEmail: {
    type: String
  },
  source: {
    type: String 
  },
  companyName: { 
    type: String
    
  },
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Company"
    
  },
  companySize: {
    type: String,
    enum: ["Small", "Medium", "Large", "Enterprise"],
    default: "Medium"
  },
  industry: { 
    type: String
    
  },
  requirement: { 
    type: String 
  },
  address: { 
    type: String 
  },
  country: { 
    type: String 
  },
  attachments: [
  {
    name: { type: String, default: "" },
    path: { type: String, default: "" },
    type: { type: String, default: "application/octet-stream" },
    size: { type: Number, default: 0 },
    uploadedAt: { type: Date, default: Date.now },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
],
  // Lost deal fields
  lossReason: {
    type: String,
    default: ""
  },
  lossNotes: {
    type: String,
    default: ""
  },
  stageLostAt: {
    type: String,
    default: null
  },
  lostDate: {
    type: Date,
    default: null
  },
  wonAt: {
    type: Date
    
  },
  wonBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  },
  clientReviewId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ClientReview",
  },
  // Follow-up fields
  followUpDate: {
    type: Date,
    default: null
    
  },
  followUpComment: {
    type: String,
    default: ''
  },
  followUpHistory: [
    {
      date: { type: Date, default: Date.now },
      followUpDate: { type: Date },
      followUpComment: { type: String },
      changedBy: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: "User" 
      },
      action: { 
        type: String, 
        enum: ["Created", "Updated", "Completed", "Cancelled", "Rescheduled", "Scheduled"]
      }
    }
  ],
  //deal created time
  createdAt: { 
    type: Date, 
    default: Date.now 
  },
  //deal updated time
  updatedAt: { 
    type: Date, 
    default: Date.now 
  },
  lastReminderAt: {
    type: Date,
    default: null
    
  }
});

dealSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  
  // Only set convertedAt if it's a new deal AND stage is Qualification
  if (this.isNew && this.stage === "Qualification" && !this.convertedAt) {
    this.convertedAt = new Date();
  }
  
  next();
});
// ALL INDEXES DEFINED IN ONE PLACE - NO DUPLICATES
dealSchema.index({ companyName: 1 });
dealSchema.index({ companyId: 1 });
dealSchema.index({ stage: 1 });
dealSchema.index({ industry: 1 });
dealSchema.index({ followUpDate: 1 });
dealSchema.index({ lastReminderAt: 1 });
dealSchema.index({ wonAt: 1 });
dealSchema.index({ createdAt: -1 });

const Deal = mongoose.model("Deal", dealSchema);
export default Deal;