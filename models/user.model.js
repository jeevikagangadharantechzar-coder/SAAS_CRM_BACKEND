import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },

    email: {
      type: String,
      
      lowercase: true,
      trim: true,
    },

    password: {
      type: String,
      required: true,
      minlength: 6,
    },

    mobileNumber: String,

    role: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Role",
      required: true,
    },

    status: {
      type: String,
      enum: ["Active", "Inactive"],
      default: "Active",
    },

    gender: {
      type: String,
      enum: ["Male", "Female", "Other"],
      default: "Other",
    },

    loginHistory: {
      type: [
        {
          login: { type: Date },
          logout: { type: Date },
        },
      ],
      default: [],
    },

    address: String,


    dateOfBirth: {
      type: Date,
      required: [true, "Date of birth is required"],
    },


    profileImage: String,

    resetPasswordToken: String,
    resetPasswordExpire: Date,
    tokenVersion: { type: Number, default: 0 },

    googleAuth: {
      accessToken:  { type: String },
      refreshToken: { type: String },
      expiryDate:   { type: Number },
      scope:        { type: String },
      connected:    { type: Boolean, default: false },
      connectedAt:  { type: Date },
    },
  },
  { timestamps: true },
);




export default mongoose.model("User", userSchema);
