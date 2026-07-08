// Shared trial-date math — used by cron/freeTrialCron.js, middlewares/checkTrialExpiry.js,
// and the trial-status endpoint, so the "days left" a reminder fires on and the
// "days left" shown/blocked in the UI can never drift apart.
//
// Uses CALENDAR days (midnight-to-midnight), not a raw ms-difference ceil, so the
// milestone table below matches regardless of what time-of-day plan_end_date happens
// to carry (e.g. a manual date edit in Compass/Atlas that doesn't set a time):
//
//   Plan start 2026-07-01, Plan end 2026-07-14
//   7 days left -> 2026-07-07   3 days left -> 2026-07-11
//   1 day left  -> 2026-07-13   Expires     -> 2026-07-14
const DAY_MS = 24 * 60 * 60 * 1000;

const startOfDay = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

/** Whole calendar days between "now" and plan_end_date (can be negative once expired). */
export const getCalendarDaysLeft = (planEndDate, now = new Date()) =>
  Math.round((startOfDay(planEndDate).getTime() - startOfDay(now).getTime()) / DAY_MS);

export const formatExpiryDate = (date) =>
  new Date(date).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

// Ordered nearest-to-expiry first: whichever is the smallest threshold still
// >= daysLeft is "the milestone currently due" — handles both the normal day-by-day
// countdown and a jump (manual test edit, missed cron run) landing between thresholds,
// e.g. daysLeft = 5 is still bucketed under the 7-day reminder since 3 hasn't hit yet.
const MILESTONES = [1, 3, 7];

export const getDueTrialMilestone = (daysLeft) => {
  if (daysLeft <= 0) return null;
  return MILESTONES.find((m) => daysLeft <= m) ?? null;
};
