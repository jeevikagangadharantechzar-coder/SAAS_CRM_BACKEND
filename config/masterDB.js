import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

// Dedicated connection to crm_master — holds Tenant + SuperAdmin docs only
export const masterConn = mongoose.createConnection(
  process.env.MASTER_DB_URI || "mongodb://localhost:27017/crm_master"
);

masterConn.on("connected", () => console.log("Master DB connected"));
masterConn.on("error", (err) => console.error("Master DB error:", err.message));
