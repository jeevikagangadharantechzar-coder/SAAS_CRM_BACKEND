import mongoose from "mongoose";
import dotenv from "dotenv";
import { registerTenantModels } from "../models/tenant/index.js";

dotenv.config();

// One Mongoose connection per tenant DB, reused across requests
const connectionPool = new Map();

export async function getTenantDB(dbName) {
  if (connectionPool.has(dbName)) {
    return connectionPool.get(dbName);
  }

  let baseUri =
    process.env.MONGO_BASE_URI ||
    (process.env.MONGO_URL || "mongodb://localhost:27017").replace(/\/[^/]*$/, "");
  
  baseUri = baseUri.replace(/\/+$/, "");

  const conn = await mongoose
    .createConnection(`${baseUri}/${dbName}`)
    .asPromise();

  registerTenantModels(conn);
  connectionPool.set(dbName, conn);
  console.log(`Tenant DB connected: ${dbName}`);
  return conn;
}

export async function dropTenantDB(dbName) {
  let baseUri =
    process.env.MONGO_BASE_URI ||
    (process.env.MONGO_URL || "mongodb://localhost:27017").replace(/\/[^/]*$/, "");
  baseUri = baseUri.replace(/\/+$/, "");

  if (connectionPool.has(dbName)) {
    const conn = connectionPool.get(dbName);
    try {
      await conn.db.dropDatabase();
      await conn.close();
    } catch (err) {
      console.error(`Error dropping DB ${dbName}:`, err);
    }
    connectionPool.delete(dbName);
  } else {
    try {
      const conn = await mongoose.createConnection(`${baseUri}/${dbName}`).asPromise();
      await conn.db.dropDatabase();
      await conn.close();
    } catch (err) {
      console.error(`Error connection/dropping DB ${dbName}:`, err);
    }
  }
  console.log(`Tenant DB dropped: ${dbName}`);
}
