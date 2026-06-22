import mongoose from "mongoose";

const callLogSchema = new mongoose.Schema({
  leadId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Lead",
    required: false,  
    index: true
  },
  dealId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Deal",
    required: false,   
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true
  },
  callType: {
    type: String,
    enum: ["whatsapp", "phone"],
    default: "phone"
  },
  phoneNumber: {
    type: String,
    required: true,
    trim: true
  },
  callStatus: {
    type: String,
    enum: ["initiated", "in-progress", "completed", "missed", "failed"],
    default: "initiated"
  },
  notes: {
    type: String,
    default: ""
  },
  // AUTO-TRACKING FIELDS
  startTime: {
    type: Date,
    default: null
  },
  endTime: {
    type: Date,
    default: null
  },
  duration: {
    type: Number, // in seconds
    default: 0,
    min: 0
  },
  // TRACKING IDENTIFIERS
  sessionId: {
    type: String,
    unique: true,
    sparse: true
  },
  trackingMethod: {
    type: String,
    enum: ["visibility", "webhook", "timestamp", "manual"],
    default: "visibility"
  },
  // METADATA
  userAgent: String,
  ipAddress: String,
  initiatedBy: {
    type: String,
    enum: ["user", "bot"],
    default: "user"
  },
  metadata: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

// AUTO-CALCULATE DURATION BEFORE SAVING
callLogSchema.pre('save', function (next) {
  if (this.startTime && this.endTime) {
    this.duration = Math.floor((this.endTime - this.startTime) / 1000);
    if (this.duration > 0) {
      this.callStatus = "completed";
    } else if (this.duration === 0 && this.startTime) {
      this.callStatus = "missed";
    }
  }
  next();
});

// VIRTUAL FOR FORMATTED DURATION
callLogSchema.virtual("formattedDuration").get(function () {
  if (!this.duration) return "0s";
  const mins = Math.floor(this.duration / 60);
  const secs = this.duration % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
});

callLogSchema.index({ userId: 1, createdAt: -1 });
callLogSchema.index({ leadId: 1, createdAt: -1 });
callLogSchema.index({ dealId: 1, createdAt: -1 });  // ← added for deal queries

const CallLog = mongoose.model("CallLog", callLogSchema);
export default CallLog;