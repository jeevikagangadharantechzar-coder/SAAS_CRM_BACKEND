import mongoose from "mongoose";

// Tracks concurrent-login device slots for Sales users — one "web" slot and
// one "mobile" slot per user. A device beyond those two goes to "pending"
// until an Admin approves it (see user.controller.js loginUser / decideDeviceRequest).
const deviceSessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    deviceType: { type: String, enum: ["web", "mobile"], required: true },

    // Stable client-generated identifier (persisted in localStorage on web,
    // device UUID on mobile) — lets us recognize "same device logging in
    // again" vs. "a genuinely new device" without relying on IP/UA alone.
    deviceId: { type: String, required: true },

    // Human-readable label for the admin approval UI, e.g. "Chrome on Windows".
    deviceLabel: { type: String, default: "" },

    // Embedded in the JWT payload once a session goes active; protect()
    // checks this against status="active" on every request so a single
    // device's session can be revoked without invalidating the other slot.
    sessionId: { type: String, default: null, index: true },

    status: {
      type: String,
      enum: ["pending", "active", "rejected", "revoked"],
      default: "pending",
    },

    requestedAt: { type: Date, default: Date.now },
    decidedAt:   { type: Date, default: null },
    decidedBy:   { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    lastActiveAt:{ type: Date, default: Date.now },
    ipAddress:   { type: String, default: "" },
  },
  { timestamps: true }
);

deviceSessionSchema.index({ userId: 1, status: 1 });
deviceSessionSchema.index({ userId: 1, deviceId: 1 });

export default deviceSessionSchema;
