import mongoose from "mongoose";
import dotenv from 'dotenv';

dotenv.config();

 const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URL,{
            serverSelectionTimeoutMS: 30000,  
            socketTimeoutMS: 30000 
        })
        console.log("MongoDB Connected");
    } catch (error) {
        console.error("MongoDB Connection Error:", error);
        process.exit(1); 
    }
};

export default connectDB;