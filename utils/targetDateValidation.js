// Shared Start Date / End Date validation for target management.
// isCreate=true also blocks a past Start Date (only enforced when a target is first created).
//
// Dates arrive as "YYYY-MM-DD" strings, which the JS Date parser always treats
// as UTC midnight (spec-guaranteed, regardless of server timezone). We compare
// everything in UTC-day space so validation never shifts by a day depending on
// where the Node process happens to be hosted.
const toUTCDay = (date) => Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

export function validateTargetDates(startDate, endDate, { isCreate = true } = {}) {
  if (!startDate || !endDate) {
    return "Start Date and End Date are required.";
  }

  const start = new Date(startDate);
  const end = new Date(endDate);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return "Start Date and End Date must be valid dates.";
  }

  const todayDay = toUTCDay(new Date());
  const startDay = toUTCDay(start);
  const endDay = toUTCDay(end);

  if (isCreate && startDay < todayDay) {
    return "Start Date cannot be a past date.";
  }

  if (endDay <= todayDay) {
    return "End Date must be a future date — today or a past date is not allowed.";
  }

  if (endDay <= startDay) {
    return "End Date must be after Start Date.";
  }

  return null;
}
