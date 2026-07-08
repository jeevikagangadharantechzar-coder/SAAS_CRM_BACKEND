// Free-trial expiry reminder cron — separate from cron/notificationCron.js
// since this tracks tenant-lifecycle milestones (7/3/1 days left, expired)
// rather than per-record lead/deal/proposal follow-ups.
import cron from "node-cron";
import mongoose from "mongoose";
import Tenant from "../models/master/Tenant.js";
import { getTenantDB } from "../config/tenantDB.js";
import { sendTrialReminder, sendTrialExpiredNotification } from "../services/freeTrialNotification.service.js";
import { getCalendarDaysLeft, getDueTrialMilestone } from "../utils/trialDate.util.js";

/**
 * Checks a single tenant's plan_end_date against the 7/3/1-day-left and
 * expired milestones, sends whichever one is due (if not already sent), and
 * persists the sent-flag. Shared by the scheduled cron, the change-stream
 * watcher (instant reaction to a direct DB edit), and the manual
 * superadmin-triggered run-cron endpoint.
 *
 * `forceReset` clears every sent-flag before evaluating — used whenever
 * plan_end_date was just explicitly edited (a real trial extension, or a
 * manual date change while testing), since the whole timeline has shifted
 * and whatever milestone the new date lands on should fire fresh, even if
 * it's the exact same threshold that already fired under the old date. The
 * scheduled hourly sweep does NOT force-reset — plan_end_date doesn't change
 * there, "now" just naturally advances through 7 → 3 → 1 → expired once, in
 * order, so the normal sent-once flags are exactly what's wanted.
 */
const MILESTONE_FLAG = { 7: "sevenDaySent", 3: "threeDaySent", 1: "oneDaySent" };

export const checkTenantTrialMilestones = async (tenant, { forceReset = false } = {}) => {
  if (tenant.plan_status !== "trial" || !tenant.plan_end_date) return false;

  // Calendar-day diff, not a raw ms/Math.ceil — see utils/trialDate.util.js for why
  // (a manual DB date edit rarely lines up its time-of-day with "now").
  const daysLeft = getCalendarDaysLeft(tenant.plan_end_date);
  const tenantDB = await getTenantDB(tenant.dbName);

  let changed = false;

  if (forceReset) {
    if (
      tenant.trialReminders?.sevenDaySent ||
      tenant.trialReminders?.threeDaySent ||
      tenant.trialReminders?.oneDaySent ||
      tenant.expiredNotifSent
    ) {
      tenant.trialReminders.sevenDaySent = false;
      tenant.trialReminders.threeDaySent = false;
      tenant.trialReminders.oneDaySent = false;
      tenant.expiredNotifSent = false;
      changed = true;
    }
  } else {
    // Hourly-sweep path only: re-arm any milestone the deadline has moved
    // back past (e.g. a real trial extension pushed the date from "3 days
    // left" back out to "7 days left").
    if (daysLeft > 7 && tenant.trialReminders?.sevenDaySent) { tenant.trialReminders.sevenDaySent = false; changed = true; }
    if (daysLeft > 3 && tenant.trialReminders?.threeDaySent) { tenant.trialReminders.threeDaySent = false; changed = true; }
    if (daysLeft > 1 && tenant.trialReminders?.oneDaySent)   { tenant.trialReminders.oneDaySent   = false; changed = true; }
    if (daysLeft > 0 && tenant.expiredNotifSent)             { tenant.expiredNotifSent             = false; changed = true; }
  }

  // Only mark a milestone as sent once a notification was actually created —
  // a transient failure (e.g. no admin user resolved) should let the next
  // check retry instead of silently marking it done.
  if (daysLeft <= 0) {
    if (!tenant.expiredNotifSent) {
      const created = await sendTrialExpiredNotification(tenant, tenantDB);
      if (created.length) {
        tenant.expiredNotifSent = true;
        changed = true;
      }
    }
  } else {
    // The nearest threshold still >= daysLeft — always exactly one milestone,
    // even if daysLeft lands between 7/3/1 (missed sweep) or a manual test
    // edit jumps straight to "1 day left" without passing through 7 and 3.
    const dueMilestone = getDueTrialMilestone(daysLeft);
    const flagKey = dueMilestone && MILESTONE_FLAG[dueMilestone];

    if (flagKey && !tenant.trialReminders?.[flagKey]) {
      const created = await sendTrialReminder(tenant, dueMilestone, tenantDB);
      if (created.length) {
        tenant.trialReminders[flagKey] = true;
        changed = true;
      }
    }
  }

  if (changed) await tenant.save();
  return changed;
};

let isCronRunning = false;

const runFreeTrialCron = async () => {
  if (isCronRunning) { console.log("Free-trial cron already running, skipping"); return; }
  if (mongoose.connection.readyState !== 1) { console.log("MongoDB not connected, skipping free-trial cron run"); return; }

  isCronRunning = true;
  const startTime = Date.now();
  try {
    console.log(`Free-Trial Cron Started: ${new Date().toISOString()}`);

    const tenants = await Tenant.find({
      plan_status: "trial",
      isActive: true,
      plan_end_date: { $ne: null },
    });

    for (const tenant of tenants) {
      try {
        await checkTenantTrialMilestones(tenant);
      } catch (err) {
        console.error(`Free-trial cron error for tenant ${tenant.slug}:`, err.message);
      }
    }

    console.log(`Free-Trial Cron Completed in ${Date.now() - startTime}ms`);
  } catch (error) {
    console.error("FATAL FREE-TRIAL CRON ERROR:", error);
  } finally {
    isCronRunning = false;
  }
};

let cronTask = null;

export const startFreeTrialCron = () => {
  if (cronTask) cronTask.stop();
  // Hourly safety-net sweep — the change-stream watcher below handles instant
  // reaction to actual date edits, this just guards against a missed event
  // (e.g. the server was down when the edit happened).
  cronTask = cron.schedule("0 * * * *", async () => {
    try { await runFreeTrialCron(); }
    catch (err) { console.error("Free-trial cron execution error:", err); }
  });

  console.log(`Free-Trial Cron scheduled: ${new Date().toISOString()}`);
};

startFreeTrialCron();

// Run once as soon as the DB connection is up (server boot / nodemon
// restart) — this module is imported before connectDB() runs, so an
// immediate call here would always see readyState !== 1 and skip.
mongoose.connection.on("connected", () => {
  runFreeTrialCron().catch((err) => console.error("Free-trial cron initial run error:", err));
});

// Instant reaction to a direct edit of plan_end_date (e.g. via Mongo
// Compass/Atlas while testing, or any future admin tool) — MongoDB Change
// Streams require a replica set, which Atlas provides by default. Falls back
// silently to the hourly sweep above if the deployment doesn't support them
// (e.g. a standalone local mongod).
const watchTenantChanges = () => {
  try {
    const stream = Tenant.watch(
      [
        {
          $match: {
            $or: [
              // Targeted field edit (Atlas/Compass inline edit, $set updates)
              { operationType: "update", "updateDescription.updatedFields.plan_end_date": { $exists: true } },
              // Full-document replace (some GUI editors replace the whole
              // doc on save instead of a targeted $set) — can't tell in
              // advance whether plan_end_date changed, so this errs toward
              // re-checking rather than silently missing the edit.
              { operationType: "replace" },
            ],
          },
        },
      ],
      { fullDocument: "updateLookup" }
    );

    stream.on("change", async (event) => {
      if (!event.fullDocument?._id) return;
      try {
        // event.fullDocument is a plain object from the driver, not a
        // hydrated Mongoose document — re-fetch so checkTenantTrialMilestones
        // can call .save() on it.
        const tenant = await Tenant.findById(event.fullDocument._id);
        if (tenant) await checkTenantTrialMilestones(tenant, { forceReset: true });
      } catch (err) {
        console.error("Free-trial change-stream error:", err.message);
      }
    });

    stream.on("error", (err) => {
      console.warn("Free-trial Tenant change stream error (falling back to hourly sweep only):", err.message);
    });

    console.log("Free-Trial change stream watching Tenant.plan_end_date for instant updates");
  } catch (err) {
    console.warn("Free-trial change stream unavailable (falling back to hourly sweep only):", err.message);
  }
};

mongoose.connection.on("connected", watchTenantChanges);

process.on("SIGINT",  () => { if (cronTask) cronTask.stop(); });
process.on("SIGTERM", () => { if (cronTask) cronTask.stop(); });

export { runFreeTrialCron };
