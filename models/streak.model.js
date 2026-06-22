import mongoose from 'mongoose';

const streakSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  currentStreak: {
    type: Number,
    default: 0
  },
  longestStreak: {
    type: Number,
    default: 0
  },
  productiveDays: {
    type: Number,
    default: 0
  },
  lastLoginDate: {
    type: Date,
    default: Date.now
  },
  loginHistory: [{
    date: Date,
    activity: String,
    timestamp: { type: Date, default: Date.now }
  }],
  performanceMetrics: {
    totalDeals: { type: Number, default: 0 },
    leadsConverted: { type: Number, default: 0 },
    conversionRate: { type: Number, default: 0 },
    totalDealValue: { type: Number, default: 0 },
    performanceScore: { type: Number, default: 0 },
    status: { 
      type: String, 
      enum: ['new', 'active', 'rising', 'top', 'star', 'inactive'], 
      default: 'new' 
    }
  }
}, {
  timestamps: true
});
const Streak = mongoose.model('Streak', streakSchema);
export default Streak;