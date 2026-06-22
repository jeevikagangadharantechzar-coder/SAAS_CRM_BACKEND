import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import crypto from "crypto";

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
      validate: {
        validator: function(value) {
          const today = new Date();
          const birthDate = new Date(value);
          
          
          if (birthDate > today) {
            return false;
          }
          
          
          let age = today.getFullYear() - birthDate.getFullYear();
          const monthDiff = today.getMonth() - birthDate.getMonth();
          
          if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
            age--;
          }
          
          
          return age >= 18 && age <= 100;
        },
        message: "Date of birth must be valid. User must be between 18 years old"
      }
    },


    profileImage: String,

    resetPasswordToken: String,
    resetPasswordExpire: Date,
    tokenVersion: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// AUTO DROP the old unique email index from MongoDB on startup
mongoose.connection.once("open", async () => {
  try {
    const collection = mongoose.connection.collection("users");
    const indexes = await collection.indexes();
    const emailIndex = indexes.find(
      (idx) => idx.key && idx.key.email !== undefined && idx.unique === true
    );
    if (emailIndex) {
      await collection.dropIndex(emailIndex.name);
      console.log(" Dropped unique email index from users collection");
    }
  } catch (err) {
    console.log(" Could not drop email index (may not exist):", err.message);
  }
});

// HASH PASSWORD
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) {
    return next();
  }

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);

  next();
});

// COMPARE PASSWORD
userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

// GENERATE RESET TOKEN
userSchema.methods.getResetPasswordToken = function () {
  const resetToken = crypto.randomBytes(32).toString("hex");

  this.resetPasswordToken = crypto
    .createHash("sha256")
    .update(resetToken)
    .digest("hex");

  // 30 minutes expiry
  this.resetPasswordExpire = Date.now() + 30 * 60 * 1000;

  return resetToken;
};

export default mongoose.model("User", userSchema);
