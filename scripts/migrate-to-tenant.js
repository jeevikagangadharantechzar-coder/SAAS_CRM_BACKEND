/**
 * migrate-to-tenant.js
 *
 * Copies all data from the legacy single-tenant MongoDB database into a
 * specific tenant's isolated database.
 *
 * Usage:
 *   node scripts/migrate-to-tenant.js <tenantSlug>
 *
 * Example:
 *   node scripts/migrate-to-tenant.js acme
 *
 * Requirements:
 *   - MONGO_URL         — old single-tenant DB connection string (in .env)
 *   - MASTER_DB_URI     — master DB connection string (in .env)
 *   - MONGO_BASE_URI    — base URI for tenant DBs, e.g. mongodb://localhost:27017
 *
 * The script is IDEMPOTENT — safe to run multiple times. Documents that
 * already exist in the tenant DB (same _id) are skipped, not duplicated.
 */

import mongoose from "mongoose";
import dotenv from "dotenv";
import { masterConn } from "../config/masterDB.js";
import Tenant from "../models/master/Tenant.js";

dotenv.config();

// ── Collection mapping: old DB collection name → tenant DB collection name ──
// Both sides use the same Mongoose model names so collection names match.
// Listed here explicitly so the mapping is obvious and easy to adjust.
const COLLECTIONS = [
  { from: "users",            to: "users" },
  { from: "roles",            to: "roles" },
  { from: "leads",            to: "leads" },
  { from: "deals",            to: "deals" },
  { from: "activities",       to: "activities" },
  { from: "invoices",         to: "invoices" },
  { from: "proposals",        to: "proposals" },
  { from: "calllogs",         to: "calllogs" },
  { from: "notifications",    to: "notifications" },
  { from: "gmailtokens",      to: "gmailtokens" },
  { from: "whatsappmessages", to: "whatsappmessages" },
  { from: "clientltvs",       to: "clientltvs" },
  { from: "supporttickets",   to: "supporttickets" },
  { from: "clientreviews",    to: "clientreviews" },
  { from: "renewals",         to: "renewals" },
  { from: "streaks",          to: "streaks" },
  { from: "settings",         to: "settings" },
];

async function migrateCollection(fromDB, toDB, fromName, toName) {
  const docs = await fromDB.collection(fromName).find({}).toArray();

  if (docs.length === 0) {
    console.log(`  [SKIP]  ${fromName} — empty`);
    return { inserted: 0, skipped: 0 };
  }

  try {
    const result = await toDB.collection(toName).insertMany(docs, { ordered: false });
    return { inserted: result.insertedCount, skipped: 0 };
  } catch (err) {
    // BulkWriteError code 11000 = duplicate _id — count them as skipped
    if (err.code === 11000 || err.name === "MongoBulkWriteError") {
      const inserted = err.result?.nInserted ?? err.insertedCount ?? 0;
      const skipped  = docs.length - inserted;
      return { inserted, skipped };
    }
    throw err;
  }
}

async function main() {
  const slug = process.argv[2];

  if (!slug) {
    console.error("Usage: node scripts/migrate-to-tenant.js <tenantSlug>");
    process.exit(1);
  }

  console.log(`\n Migration starting for tenant: "${slug}"\n`);

  // ── 1. Connect to old (legacy) DB ──────────────────────────────────────
  const oldMongoUrl = process.env.MONGO_URL;
  if (!oldMongoUrl) {
    console.error("MONGO_URL is not set in .env");
    process.exit(1);
  }

  const oldConn = await mongoose.createConnection(oldMongoUrl).asPromise();
  const oldDB   = oldConn.db;
  console.log(`Old DB connected: ${oldDB.databaseName}`);

  // ── 2. Wait for master DB and look up tenant ────────────────────────────
  await masterConn.asPromise();
  const tenant = await Tenant.findOne({ slug });

  if (!tenant) {
    console.error(`Tenant with slug "${slug}" not found in master DB.`);
    console.error("Create the tenant first via POST /superadmin/api/tenants/create");
    await oldConn.close();
    process.exit(1);
  }

  console.log(`Tenant found: ${tenant.name}  →  DB: ${tenant.dbName}`);

  // ── 3. Connect to tenant DB ─────────────────────────────────────────────
  const baseUri =
    process.env.MONGO_BASE_URI ||
    oldMongoUrl.replace(/\/[^/]*(\?.*)?$/, "");

  const tenantConn = await mongoose
    .createConnection(`${baseUri}/${tenant.dbName}`)
    .asPromise();
  const tenantDB = tenantConn.db;
  console.log(`Tenant DB connected: ${tenantDB.databaseName}\n`);

  // ── 4. Copy each collection ─────────────────────────────────────────────
  let totalInserted = 0;
  let totalSkipped  = 0;

  for (const { from, to } of COLLECTIONS) {
    process.stdout.write(`  Migrating ${from.padEnd(20)}`);

    const { inserted, skipped } = await migrateCollection(oldDB, tenantDB, from, to);
    totalInserted += inserted;
    totalSkipped  += skipped;

    if (inserted === 0 && skipped === 0) {
      console.log("— (no documents)");
    } else {
      console.log(`→  inserted: ${inserted}  skipped (already exist): ${skipped}`);
    }
  }

  // ── 5. Summary ──────────────────────────────────────────────────────────
  console.log("\n─────────────────────────────────────────");
  console.log(` Migration complete`);
  console.log(`  Total inserted : ${totalInserted}`);
  console.log(`  Total skipped  : ${totalSkipped}`);
  console.log("─────────────────────────────────────────\n");

  await oldConn.close();
  await tenantConn.close();
  await masterConn.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("\n Migration failed:", err.message);
  process.exit(1);
});
