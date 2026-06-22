import mongoose from "mongoose";

const clientReviewSchema = new mongoose.Schema({
  companyId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "Deal", 
    required: true 
  },
  companyName: { 
    type: String, 
    required: true 
  },
  clientName: { 
    type: String, 
    required: true 
  },
  dealId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "Deal", 
    required: true 
  },
  dealValue: { 
    type: Number, 
    default: 0 
  },
  lastFollowUp: { 
    type: Date 
  },
  salespersonId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "User" 
  },
  salespersonName: { 
    type: String 
  },
  supportTickets: { 
    type: Number, 
    default: 0 
  },
  progress: { 
    type: String, 
    enum: ["Excellent", "Good", "Average", "Poor"],
    default: "Average" 
  },
  reviewNotes: { 
    type: String 
  },
  clientHealthScore: { 
    type: Number, 
    min: 0, 
    max: 100, 
    default: 50 
  },
  upsellOpportunity: { 
    type: Boolean, 
    default: false 
  },
  positiveReply: { 
    type: Boolean, 
    default: false 
  },
  reviewedAt: { 
    type: Date, 
    default: Date.now 
  },
  reviewedBy: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "User" 
  }
}, {
  timestamps: true
});

const ClientReview = mongoose.model("ClientReview", clientReviewSchema);
export default ClientReview;