/**
 * Seeds the default SuperAdmin into crm_master.
 *
 * Usage:
 *   node seeder/superAdmin.seeder.js
 *
 * Set SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD in .env to override defaults.
 * Safe to re-run — existing record is updated, not duplicated.
 */

import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import { masterConn } from "../config/masterDB.js";
import SuperAdmin from "../models/master/SuperAdmin.js";

dotenv.config();

const NAME     = process.env.SUPERADMIN_NAME     || "Super Admin";
const EMAIL    = process.env.SUPERADMIN_EMAIL    || "superadmin@crm.com";
const PASSWORD = process.env.SUPERADMIN_PASSWORD || "superadmin123";

async function seed() {
  try {
    await masterConn.asPromise();
    console.log("Master DB connected");

    const hashed = await bcrypt.hash(PASSWORD, 10);

    const existing = await SuperAdmin.findOne({ email: EMAIL.toLowerCase() });

    if (existing) {
      existing.name     = NAME;
      existing.password = hashed;
      await existing.save();
      console.log(`SuperAdmin updated: ${EMAIL}`);
    } else {
      await SuperAdmin.create({ name: NAME, email: EMAIL.toLowerCase(), password: hashed });
      console.log(`SuperAdmin created: ${EMAIL}`);
    }

    console.log(`Password: ${PASSWORD}`);
    console.log("Done.");
    process.exit(0);
  } catch (err) {
    console.error("Seeder failed:", err.message);
    process.exit(1);
  }
}

seed();
