import mongoose, { Mongoose } from "mongoose";

const PasswordSchema = new mongoose.Schema({
   
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
});

const User = mongoose.model("Password", PasswordSchema);

export default User;
