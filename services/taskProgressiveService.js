// Task Management / My Tasks "Progress card" ratio computation.
//
// Deliberately entirely independent of Target Management's
// target.controller.js (no imports from it, no shared function) — per
// explicit user request, a change here must never be able to affect Target
// Management/My Targets, and vice versa, even if the two happen to use a
// similar self-only-counting rule.
//
// A Task has no admin-set numeric quota the way a Target does. Its implicit
// "goal" is simply every lead/deal actually linked to it right now
// (task.leadRefs/task.dealRefs), so a task assigned 5 leads + 5 deals where
// only 1 deal is won reads as 1/10 progress — not 100% off a single win.
// Linking/unlinking an item changes the pool on the very next fetch since
// everything below is derived live from the task's current arrays, never
// cached.
//
// A "win" counts regardless of path: a directly-linked deal closed Won, OR a
// linked lead that converted and its resulting deal was later closed Won —
// both move the same needle.
//
// Same self-only attribution rule as Target Management (a sales person's own
// conversions/wins count toward their percentage; anything Admin did on
// their behalf does not, and instead surfaces separately in Task
// Management's "Admin Completed" tab).

const STAGE_HISTORY_MOVER_POPULATE = {
  path: "stageHistory.movedBy",
  select: "firstName lastName role",
  populate: { path: "role", select: "name" },
};

// Whether the CURRENT "Closed Lost" state was actually set by this user
// themselves — deals have no dedicated "lostBy" field the way they have
// "wonBy" for wins, so this reads it off stageHistory's most recent
// "Closed Lost" entry instead.
function wasLostBySelf(stageHistory, idStr) {
  const lostMoves = (stageHistory || []).filter((h) => h.stage === "Closed Lost");
  if (!lostMoves.length) return false;
  const latest = lostMoves[lostMoves.length - 1];
  return String(latest.movedBy?._id || latest.movedBy || "") === idStr;
}

// Batched Progress-card ratio for every one of a sales person's tasks in one
// call. Returns a map keyed by taskId so each task card only ever shows
// progress scoped to its OWN linked leads/deals.
export async function computeTaskProgress(models, userId, tasks) {
  const { Deal, CallLog, Activity } = models;
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const idStr = String(userId);

  // Calls/meetings aren't scoped to a specific lead/deal — computed once per
  // user and shared across all of that user's task cards.
  const [calls, meetings] = await Promise.all([
    CallLog.countDocuments({ userId, createdAt: { $gte: monthStart, $lte: now } }),
    Activity.countDocuments({ assignedTo: userId, activityCategory: "Meeting", startDate: { $gte: monthStart, $lte: now } }),
  ]);

  const emptyEntry = () => ({
    _id: null,
    salesPerson: userId,
    targetLeads: 0,
    targetDeals: 0,
    targetCalls: 0,
    targetMeetings: 0,
    startDate: monthStart,
    endDate: now,
    isFallback: true,
    actuals: { leadsConverted: 0, dealsWon: 0, leadDealWon: 0, dealsLost: 0, calls, meetings },
    percentages: { leadsPercent: 0, dealsPercent: 0, callsPercent: 0, meetingsPercent: 0, overall: 0 },
  });

  const result = {};
  await Promise.all((tasks || []).map(async (task) => {
    // Backward-compat: older tasks only ever set the singular leadRef/dealRef.
    const linkedLeadIds = (task.leadRefs && task.leadRefs.length) ? task.leadRefs : (task.leadRef ? [task.leadRef] : []);
    const linkedDealIds = (task.dealRefs && task.dealRefs.length) ? task.dealRefs : (task.dealRef ? [task.dealRef] : []);
    if (!linkedLeadIds.length && !linkedDealIds.length) {
      result[String(task._id)] = emptyEntry();
      return;
    }

    const [leadsConverted, dealsWon, convertedLeadDeals, existingDeals] = await Promise.all([
      linkedLeadIds.length ? Deal.countDocuments({ leadId: { $in: linkedLeadIds }, convertedBy: userId }) : 0,
      linkedDealIds.length ? Deal.countDocuments({ _id: { $in: linkedDealIds }, stage: "Closed Won", wonBy: userId }) : 0,
      linkedLeadIds.length
        ? Deal.find({ leadId: { $in: linkedLeadIds } }).select("stage wonBy stageHistory").populate(STAGE_HISTORY_MOVER_POPULATE).lean()
        : [],
      linkedDealIds.length
        ? Deal.find({ _id: { $in: linkedDealIds } }).select("stage wonBy stageHistory").populate(STAGE_HISTORY_MOVER_POPULATE).lean()
        : [],
    ]);

    // "Deals Won" counts a win from either source: a directly-linked deal
    // closed Won (dealsWon), or a linked lead that converted and whose
    // resulting deal was later closed Won (leadDealWon) — same combined
    // treatment "Deals Lost" already uses below.
    const leadDealWon = convertedLeadDeals.filter((d) => d.stage === "Closed Won" && String(d.wonBy || "") === idStr).length;
    const dealsLost =
      existingDeals.filter((d) => d.stage === "Closed Lost" && wasLostBySelf(d.stageHistory, idStr)).length +
      convertedLeadDeals.filter((d) => d.stage === "Closed Lost" && wasLostBySelf(d.stageHistory, idStr)).length;

    const targetLeads = linkedLeadIds.length;
    const targetDeals = linkedDealIds.length;
    const leadsPercent = targetLeads > 0 ? Math.min(100, Math.round((leadsConverted / targetLeads) * 100)) : 0;
    const combinedWon = dealsWon + leadDealWon;
    const combinedPool = targetLeads + targetDeals;
    const dealsPercent = combinedPool > 0 ? Math.min(100, Math.round((combinedWon / combinedPool) * 100)) : 0;
    const overall = dealsPercent;

    result[String(task._id)] = {
      _id: null,
      salesPerson: userId,
      targetLeads,
      targetDeals: combinedPool,
      targetCalls: 0,
      targetMeetings: 0,
      startDate: monthStart,
      endDate: now,
      isFallback: true,
      actuals: { leadsConverted, dealsWon: combinedWon, leadDealWon, dealsLost, calls, meetings },
      percentages: { leadsPercent, dealsPercent, callsPercent: 0, meetingsPercent: 0, overall },
    };
  }));

  return result;
}

