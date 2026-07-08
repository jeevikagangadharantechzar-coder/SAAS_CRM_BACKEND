import cron from "node-cron";
import Tenant from "../models/master/Tenant.js";
import SubscriptionPlan from "../models/master/SubscriptionPlan.model.js";
import { resetTenantDB } from "../controllers/tenant.controller.js";
import { sendPlanExpiryReminderEmail } from "../utils/dynamicEmail.js";
import mongoose from "mongoose";

const TEMP_PASSWORD = "ExpiredReset123!";

function daysUntil(date) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  return Math.round((target - now) / 86_400_000);
}

function formatDate(date) {
  return new Date(date).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });
}

// ─── Daily 9 AM — Expiry reminder emails ──────────────────────────────────
cron.schedule("0 9 * * *", async () => {
  try {
    if (mongoose.connection.readyState !== 1) return;

    const tenantsWithEndDate = await Tenant.find({
      plan_status: { $in: ["active", "grace"] },
      plan_end_date: { $ne: null },
      adminEmail: { $ne: null },
    }).populate("plan_id");

    for (const tenant of tenantsWithEndDate) {
      try {
        const days = daysUntil(tenant.plan_end_date);
        if (days !== 7 && days !== 1) continue;

        const planName = tenant.plan_id?.plan_name || "Subscription";
        await sendPlanExpiryReminderEmail({
          to: tenant.adminEmail,
          vars: {
            adminName:    tenant.adminName || "Admin",
            planName,
            endDate:      formatDate(tenant.plan_end_date),
            daysRemaining: days,
            loginUrl:     `${process.env.FRONTEND_URL || "http://localhost:3000"}/login`,
            isUrgent:     days === 1,
          },
        });

        console.log(`[Cron] Expiry reminder (${days}d) sent to ${tenant.adminEmail} for tenant ${tenant.slug}`);
      } catch (err) {
        console.error(`[Cron] Reminder email failed for ${tenant.slug}:`, err.message);
      }
    }
  } catch (err) {
    console.error("[Cron] Daily reminder job error:", err);
  }
});

// ─── Hourly — Grace period & expiry enforcement ────────────────────────────
cron.schedule("0 * * * *", async () => {
  try {
    if (mongoose.connection.readyState !== 1) return;

    const now = new Date();

    // 1. Active tenants whose plan_end_date has passed → move to grace or expire
    const activeExpired = await Tenant.find({
      plan_status: "active",
      plan_end_date: { $ne: null, $lt: now },
    }).populate("plan_id");

    for (const tenant of activeExpired) {
      try {
        // Find grace_days for this tenant's billing cycle
        let graceDays = 0;
        if (tenant.plan_id?.tiers?.length && tenant.plan_billing_cycle) {
          const tier = tenant.plan_id.tiers.find(
            (t) => t.billing_cycle === tenant.plan_billing_cycle
          );
          graceDays = tier?.grace_days ?? 0;
        }

        if (graceDays > 0) {
          tenant.plan_status = "grace";
          await tenant.save();
          console.log(`[Cron] Tenant ${tenant.slug} entered grace period (${graceDays} days)`);
        } else {
          console.log(`[Cron] Plan expired for tenant ${tenant.slug}. Wiping DB.`);
          await resetTenantDB(tenant, TEMP_PASSWORD);
          tenant.plan_status = "expired";
          await tenant.save();
        }
      } catch (err) {
        console.error(`[Cron] Active→grace/expired failed for ${tenant.slug}:`, err.message);
      }
    }

    // 2. Grace tenants whose grace period has also ended → expire & wipe
    const graceExpired = await Tenant.find({
      plan_status: "grace",
      plan_end_date: { $ne: null },
    }).populate("plan_id");

    for (const tenant of graceExpired) {
      try {
        let graceDays = 0;
        if (tenant.plan_id?.tiers?.length && tenant.plan_billing_cycle) {
          const tier = tenant.plan_id.tiers.find(
            (t) => t.billing_cycle === tenant.plan_billing_cycle
          );
          graceDays = tier?.grace_days ?? 0;
        }

        const graceEnd = new Date(tenant.plan_end_date);
        graceEnd.setDate(graceEnd.getDate() + graceDays);

        if (now >= graceEnd) {
          console.log(`[Cron] Grace period ended for tenant ${tenant.slug}. Wiping DB.`);
          await resetTenantDB(tenant, TEMP_PASSWORD);
          tenant.plan_status = "expired";
          await tenant.save();
        }
      } catch (err) {
        console.error(`[Cron] Grace→expired failed for ${tenant.slug}:`, err.message);
      }
    }
  } catch (err) {
    console.error("[Cron] Hourly subscription job error:", err);
  }
});

export default cron;
