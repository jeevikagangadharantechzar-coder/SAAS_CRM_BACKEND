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
import SuperAdminRole from "../models/master/SuperAdminRole.js";

dotenv.config();

const NAME     = process.env.SUPERADMIN_NAME     || "Super Admin";
const EMAIL    = process.env.SUPERADMIN_EMAIL    || "superadmin@crm.com";
const PASSWORD = process.env.SUPERADMIN_PASSWORD || "superadmin123";

const OWNER_ROLE_NAME = "Owner";
const FULL_PERMISSIONS = {
  dashboard: true,
  tenants: true,
  free_trials: true,
  analysis: true,
  upgrade_requests: true,
  support_tickets: true,
  subscription_plans: true,
  settings: true,
  software_enquiries: true,
  admin_users: true,
};

async function seed() {
  try {
    await masterConn.asPromise();
    console.log("Master DB connected");

    // Bootstrap account always gets a full-access role — without this, the
    // very first login would have role: null (zero permissions) and be
    // locked out of every page, including the one that grants permissions.
    // Re-synced on every run (not just created once) so a newly-added
    // permission key automatically reaches Owner instead of silently
    // defaulting to false on an already-existing role document.
    let ownerRole = await SuperAdminRole.findOne({ name: OWNER_ROLE_NAME });
    if (!ownerRole) {
      ownerRole = await SuperAdminRole.create({
        name: OWNER_ROLE_NAME,
        description: "Full access to every Super Admin feature.",
        permissions: FULL_PERMISSIONS,
      });
      console.log(`SuperAdminRole created: ${OWNER_ROLE_NAME}`);
    } else {
      ownerRole.permissions = FULL_PERMISSIONS;
      await ownerRole.save();
      console.log(`SuperAdminRole synced: ${OWNER_ROLE_NAME}`);
    }

    const hashed = await bcrypt.hash(PASSWORD, 10);

    const existing = await SuperAdmin.findOne({ email: EMAIL.toLowerCase() });

    if (existing) {
      existing.name     = NAME;
      existing.password = hashed;
      if (!existing.role) existing.role = ownerRole._id;
      await existing.save();
      console.log(`SuperAdmin updated: ${EMAIL}`);
    } else {
      await SuperAdmin.create({ name: NAME, email: EMAIL.toLowerCase(), password: hashed, role: ownerRole._id });
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
