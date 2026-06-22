import cron from "node-cron";
import Tenant from "../models/master/Tenant.js";
import { resetTenantDB } from "../controllers/tenant.controller.js";
import mongoose from "mongoose";

// Runs every hour
cron.schedule("0 * * * *", async () => {
  try {
    if (mongoose.connection.readyState !== 1) return;

    const expiredTenants = await Tenant.find({
      plan_status: "active",
      plan_end_date: { $ne: null, $lt: new Date() }
    });

    for (const tenant of expiredTenants) {
      try {
        console.log(`Plan expired for tenant ${tenant.slug}. Wiping database and setting plan_status to expired.`);
        
        // Generate new placeholder password for the reset admin user
        const tempPassword = "ExpiredReset123!";
        
        // Perform DB reset
        await resetTenantDB(tenant, tempPassword);
        
        // Mark as expired
        tenant.plan_status = "expired";
        await tenant.save();
      } catch (err) {
        console.error(`Failed to handle plan expiry for tenant ${tenant.slug}:`, err.message);
      }
    }
  } catch (err) {
    console.error("Subscription cron error:", err);
  }
});

export default cron;
