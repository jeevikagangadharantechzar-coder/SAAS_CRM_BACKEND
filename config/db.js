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
        
        // AUTO DROP the old unique email index from MongoDB on startup
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
        
    } catch (error) {
        console.error("MongoDB Connection Error:", error);
        process.exit(1); 
    }
};

export default connectDB;