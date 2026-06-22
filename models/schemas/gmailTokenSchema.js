import mongoose from "mongoose";

const gmailTokenSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  crm_user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null,
  },
  access_token:  { type: String, required: true },
  refresh_token: { type: String, required: true },
  token_type:    { type: String, default: "Bearer" },
  expiry_date:   { type: Date, required: true },
  scope:         { type: String },
  is_active:     { type: Boolean, default: true },
  created_at:    { type: Date, default: Date.now },
  updated_at:    { type: Date, default: Date.now },
  last_connected:{ type: Date, default: Date.now },
});

gmailTokenSchema.pre("save", function (next) {
  this.updated_at = new Date();
  next();
});

export default gmailTokenSchema;
