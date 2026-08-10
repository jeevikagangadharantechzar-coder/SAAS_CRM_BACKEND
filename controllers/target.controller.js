import { getTenantModels } from "../models/tenant/index.js";
import { notifyTargetUser } from "../realtime/targetSocket.js";
import { validateTargetDates } from "../utils/targetDateValidation.js";
import { checkTargetDeadlineNow } from "../cron/targetCron.js";
import {
  createNotification,
  findAdmins,
  getTakenByAdminName,
  STAGE_HISTORY_MOVER_POPULATE,
  wasLostBySelf,
} from "../services/targetNotificationService.js";
import { getBulkLinkage } from "../services/linkageService.js";

const getModels = (req) => getTenantModels(req.tenantDB);

// Compute actual counts for a user within a date range, scoped to linked leads/deals if provided
async function computeActuals(models, userId, startDate, endDate, linkedLeadIds = null, linkedDealIds = null, targetLeadsGoal = 0, targetDealsGoal = 0, reportedCallsCount = 0, reportedMeetingsCount = 0, hadSpecificLeads = false, hadSpecificDeals = false) {
  const { Lead, Deal, CallLog, Activity } = models;

  const start = new Date(startDate);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  // Leads converted: only the sales person's OWN conversions count toward
  // their personal target progress — one Admin converted on their behalf
  // shouldn't inflate a number that's supposed to reflect their own work.
  // Admin's own conversions still surface, just separately, in Task
  // Management's "Admin Completed" tab (getAdminActivity).
  //
  // If this Target didn't link any specific leads, only fall back to a
  // whole-date-range count when a leads GOAL was actually set (targetLeads >
  // 0) AND it wasn't originally a specific-lead target (which would have hadSpecificLeads=true).
  const leadsConvertedQuery = linkedLeadIds && linkedLeadIds.length > 0
    ? Deal.distinct("leadId", { 
        leadId: { $in: linkedLeadIds },
        $or: [
          { convertedBy: userId },
          { convertedBy: null, assignedTo: userId },
          { convertedBy: { $exists: false }, assignedTo: userId }
        ]
      }).then(ids => ids.length)
    : targetLeadsGoal > 0 && !hadSpecificLeads
      ? Lead.countDocuments({ assignTo: userId, status: "Converted", updatedAt: { $gte: start, $lte: end } })
      : Promise.resolve(0);

  // Deals won: same self-only rule — filtered by wonAt (the moment it was
  // actually marked Closed Won) rather than updatedAt, which bumps on ANY
  // later edit (e.g. Admin correcting the phone number next month would
  // otherwise silently un-count an already-won deal from this period, or
  // double-count it in a later one). Same no-goal-means-zero rule as leads
  // converted above.
  const dealsWonQuery = linkedDealIds && linkedDealIds.length > 0
    ? Deal.countDocuments({ _id: { $in: linkedDealIds }, stage: "Closed Won", wonBy: userId })
    : targetDealsGoal > 0 && !hadSpecificDeals
      ? Deal.countDocuments({ assignedTo: userId, stage: "Closed Won", wonAt: { $gte: start, $lte: end } })
      : Promise.resolve(0);

  const leadDealWonQuery = linkedLeadIds && linkedLeadIds.length > 0
    ? Deal.distinct("leadId", { 
        leadId: { $in: linkedLeadIds }, 
        stage: "Closed Won",
        wonBy: userId
      }).then(ids => ids.length)
    : targetLeadsGoal > 0 && !hadSpecificLeads
      ? Deal.countDocuments({ assignedTo: userId, leadId: { $ne: null }, stage: "Closed Won", wonAt: { $gte: start, $lte: end } })
      : Promise.resolve(0);

  const dealsLostQuery = (linkedDealIds && linkedDealIds.length > 0) || (linkedLeadIds && linkedLeadIds.length > 0)
    ? Deal.countDocuments({ 
        $or: [
          ...(linkedDealIds?.length ? [{ _id: { $in: linkedDealIds } }] : []),
          ...(linkedLeadIds?.length ? [{ leadId: { $in: linkedLeadIds } }] : [])
        ],
        stage: "Closed Lost" 
      })
    : targetDealsGoal > 0 || targetLeadsGoal > 0
      ? Deal.countDocuments({ assignedTo: userId, stage: "Closed Lost", updatedAt: { $gte: start, $lte: end } })
      : Promise.resolve(0);

  const [leadsConverted, dealsWon, leadDealWon, dealsLost] = await Promise.all([
    leadsConvertedQuery,
    dealsWonQuery,
    leadDealWonQuery,
    dealsLostQuery
  ]);

  return { leadsConverted, dealsWon, calls: reportedCallsCount, meetings: reportedMeetingsCount, leadDealWon, dealsLost };
}

// When a Target links SPECIFIC leads/deals and Admin personally converts/wins
// one of them instead of the sales person, that item can never be completed
// by the sales person themselves — leaving it in the denominator would cap
// their achievable percentage below 100% forever for work that was taken out
// of their hands. Effective goal = the admin-set goal minus however many of
// those specific linked items Admin already closed out, so a sales person who
// fully handles everything still reachable to them reaches 100%, not a
// fraction reduced by Admin's own completions. Only applies when specific
// leads/deals are linked (rawLinkedCount > 0) — a period-wide numeric goal
// (no curated list) has no "this exact item was taken" concept, so it's
// returned unchanged.
function effectiveGoal(rawGoal, rawLinkedCount, adminHandledCount) {
  if (rawLinkedCount > 0) {
    const intendedGoal = rawGoal > 0 ? rawGoal : rawLinkedCount;
    const reachable = Math.max(0, rawLinkedCount - adminHandledCount);
    return Math.min(intendedGoal, reachable);
  }
  return rawGoal || 0;
}

// Self-only progress snapshot for a sales person who has NO Target at all yet
// (or no Target covering today) — same self-only attribution rules as
// computeActuals/getTargets (only the sales person's own conversions/wins
// count, admin-assisted ones are excluded). Unlike a real Target (which has
// its own explicit linkedLeads/linkedDeals list), a Task only has this one
// lead/deal (task.leadRef/task.dealRef), so we scope actuals to THAT task's
// own linked item — never to the sales person's whole-month activity. Scoping
// to the whole month would leak an unrelated lead/deal the sales person
// happened to convert/win elsewhere that month onto every one of their task
// cards, including ones where Admin did all the work themselves (which must
// show 0, per the self-only rule). Returns a map keyed by taskId so every
// task card gets its own correctly-scoped snapshot from a single batched call
// — this is what powers the Task/My Tasks Progress card fallback so a sales
// person's real work on THAT specific task shows up even before an Admin
// ever creates a Target for them.
async function computeFallbackSnapshotsForTasks(models, userId, tasks) {
  const { Deal, CallLog, Activity } = models;
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const idStr = String(userId);

  // Calls/meetings aren't scoped to a specific lead/deal even for real
  // Targets (see computeActuals above) — same parity here, computed once
  // per user and shared across all of that user's task cards.
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
    const linkedLeadIds = task.leadRef ? [task.leadRef] : [];
    const linkedDealIds = task.dealRef ? [task.dealRef] : [];
    if (!linkedLeadIds.length && !linkedDealIds.length) {
      result[String(task._id)] = emptyEntry();
      return;
    }

    const [leadsConverted, dealsWon, convertedLeadDeals, existingDeals] = await Promise.all([
      linkedLeadIds.length ? Deal.distinct("leadId", { leadId: { $in: linkedLeadIds }, convertedBy: userId }).then(ids => ids.length) : 0,
      linkedDealIds.length ? Deal.countDocuments({ _id: { $in: linkedDealIds }, stage: "Closed Won", wonBy: userId }) : 0,
      linkedLeadIds.length
        ? Deal.find({ leadId: { $in: linkedLeadIds } }).select("stage wonBy stageHistory").populate(STAGE_HISTORY_MOVER_POPULATE).lean()
        : [],
      linkedDealIds.length
        ? Deal.find({ _id: { $in: linkedDealIds } }).select("stage wonBy stageHistory").populate(STAGE_HISTORY_MOVER_POPULATE).lean()
        : [],
    ]);

    // Same split as the real-Target flow: "leads to deals won" only counts
    // deals that came FROM a linked lead; "deals lost" counts either kind.
    const wonDealsForLeads = convertedLeadDeals.filter((d) => d.stage === "Closed Won" && String(d.wonBy || "") === idStr);
    const leadDealWon = new Set(wonDealsForLeads.map(d => String(d.leadId))).size;
    const dealsLost =
      existingDeals.filter((d) => d.stage === "Closed Lost" && wasLostBySelf(d.stageHistory, idStr)).length +
      convertedLeadDeals.filter((d) => d.stage === "Closed Lost" && wasLostBySelf(d.stageHistory, idStr)).length;

    // A Task has no admin-set numeric goal the way a Target does — its only
    // "goal" is its own single linked lead/deal. Treating that as an implicit
    // target of 1 (instead of always 0) means Overall Progress can actually
    // reach 100% once the sales person completes THEIR OWN linked item,
    // instead of permanently reading 0%/red/"keep pushing" even when the
    // real work is already done — same overall-averaging formula as real
    // Targets (average of leads/deals percent, only counting whichever one
    // this task actually has a goal for).
    const targetLeads = linkedLeadIds.length ? 1 : 0;
    const targetDeals = linkedDealIds.length ? 1 : 0;
    const leadsPercent = targetLeads > 0 ? (leadsConverted > 0 ? 100 : 0) : 0;
    const dealsPercent = targetDeals > 0 ? (dealsWon > 0 ? 100 : 0) : 0;
    const activePercentages = [
      targetLeads > 0 ? leadsPercent : null,
      targetDeals > 0 ? dealsPercent : null,
    ].filter((v) => v !== null);
    const overall = activePercentages.length > 0
      ? Math.round(activePercentages.reduce((a, b) => a + b, 0) / activePercentages.length)
      : 0;

    result[String(task._id)] = {
      _id: null,
      salesPerson: userId,
      targetLeads,
      targetDeals,
      targetCalls: 0,
      targetMeetings: 0,
      startDate: monthStart,
      endDate: now,
      isFallback: true,
      actuals: { leadsConverted, dealsWon, leadDealWon, dealsLost, calls, meetings },
      percentages: { leadsPercent, dealsPercent, callsPercent: 0, meetingsPercent: 0, overall },
    };
  }));

  return result;
}

export default {
  // Fetch targets linked to a specific lead or deal
  getLinkedTargets: async (req, res) => {
    try {
      const { itemType, itemId } = req.params;
      const models = getModels(req);
      const { Target, Lead, Deal } = models;

      const query = {};
      if (itemType === "lead") query.linkedLeads = itemId;
      else if (itemType === "deal") query.linkedDeals = itemId;
      else return res.status(400).json({ message: "Invalid itemType" });

      if (req.user.role?.name !== "Admin") {
        query.salesPerson = req.user._id;
      }

      const allRawTargets = await Target.find(query)
        .populate("salesPerson", "firstName lastName email")
        .populate("createdBy", "firstName lastName email")
        .populate("notes.addedBy", "firstName lastName")
        .sort({ createdAt: -1 })
        .lean();

      const rawTargets = allRawTargets.filter((t) => !!t.salesPerson);

      const result = await Promise.all(rawTargets.map(async (t) => {
        const rawLeadIds = (t.linkedLeads || []);
        const rawDealIds = (t.linkedDeals || []);

        const hadSpecificLeads = t.reasonNotes && t.reasonNotes.some(r => r.itemType === "lead");
        const hadSpecificDeals = t.reasonNotes && t.reasonNotes.some(r => r.itemType === "deal");

        const actuals = await computeActuals(models, t.salesPerson._id, t.startDate, t.endDate, rawLeadIds, rawDealIds, t.targetLeads, t.targetDeals, (t.reportedCalls || []).length, (t.reportedMeetings || []).length, hadSpecificLeads, hadSpecificDeals);

        const existingLeads = await Lead.find({ _id: { $in: rawLeadIds } })
          .select("leadName companyName phoneNumber email status createdAt statusHistory")
          .lean();

        const spIdStr = String(t.salesPerson._id || t.salesPerson);

        const convertedLeadDealsRole = { path: "convertedBy", select: "firstName lastName role", populate: { path: "role", select: "name" } };
        const wonByRole = { path: "wonBy", select: "firstName lastName role", populate: { path: "role", select: "name" } };

        const convertedLeadDeals = await Deal.find({ leadId: { $in: rawLeadIds } })
          .select("dealName leadId convertedAt convertedBy assignedTo createdAt stage value currency leadStatusHistory leadCreatedAt stageHistory lossReason lossNotes stageLostAt updatedAt companyName phoneNumber email wonAt wonBy")
          .populate(convertedLeadDealsRole)
          .populate(STAGE_HISTORY_MOVER_POPULATE)
          .lean()
          .then(deals => deals.map(d => {
            const isSPConverted = d.convertedBy
              ? String(d.convertedBy._id || d.convertedBy) === spIdStr
              : String(d.assignedTo || "") === spIdStr;
            const convertedByName = d.convertedBy
              ? `${d.convertedBy.firstName || ""} ${d.convertedBy.lastName || ""}`.trim()
              : null;
            return {
              ...d,
              salesPersonConverted: isSPConverted,
              convertedByName,
              takenByAdminName: getTakenByAdminName(d.stageHistory, String(d.assignedTo || spIdStr)),
            };
          }));

        const existingDeals = await Deal.find({ _id: { $in: rawDealIds } })
          .select("dealName dealTitle companyName phoneNumber email stage value currency wonAt wonBy convertedAt convertedBy assignedTo createdAt stageHistory lossReason lossNotes stageLostAt updatedAt")
          .populate(convertedLeadDealsRole)
          .populate(wonByRole)
          .populate(STAGE_HISTORY_MOVER_POPULATE)
          .lean()
          .then(deals => deals.map(d => {
            const takenByAdminName = getTakenByAdminName(d.stageHistory, String(d.assignedTo || spIdStr));
            if (!d.convertedBy) return { ...d, salesPersonConverted: null, convertedByName: null, takenByAdminName };
            const isSPConverted = String(d.convertedBy._id || d.convertedBy) === spIdStr;
            return {
              ...d,
              salesPersonConverted: isSPConverted,
              convertedByName: `${d.convertedBy.firstName || ""} ${d.convertedBy.lastName || ""}`.trim(),
              takenByAdminName,
            };
          }));

        const adminConvertedLeadsCount = convertedLeadDeals.filter(d => d.convertedBy?.role?.name === "Admin").length;
        const adminWonDealsCount = existingDeals.filter(d => d.stage === "Closed Won" && d.wonBy?.role?.name === "Admin").length;

        const effTargetLeads = effectiveGoal(t.targetLeads, rawLeadIds.length, adminConvertedLeadsCount);
        const effTargetDeals = effectiveGoal(t.targetDeals, rawDealIds.length, adminWonDealsCount);

        const leadsPercent = effTargetLeads > 0 
          ? Math.min(100, Math.round((actuals.leadsConverted / effTargetLeads) * 100)) 
          : (t.targetLeads > 0 && adminConvertedLeadsCount >= rawLeadIds.length && rawLeadIds.length > 0 ? 100 : 0);
        const dealsPercent = effTargetDeals > 0 
          ? Math.min(100, Math.round((actuals.dealsWon / effTargetDeals) * 100)) 
          : (t.targetDeals > 0 && adminWonDealsCount >= rawDealIds.length && rawDealIds.length > 0 ? 100 : 0);
        const leadDealWonPercent = effTargetLeads > 0 
          ? Math.min(100, Math.round((actuals.leadDealWon / effTargetLeads) * 100)) 
          : (t.targetLeads > 0 && adminConvertedLeadsCount >= rawLeadIds.length && rawLeadIds.length > 0 ? 100 : 0);
        const callsPercent = t.targetCalls > 0 ? Math.min(100, Math.round((actuals.calls / t.targetCalls) * 100)) : 0;
        const meetingsPercent = t.targetMeetings > 0 ? Math.min(100, Math.round((actuals.meetings / t.targetMeetings) * 100)) : 0;
        const activePercentages = [
          t.targetLeads > 0 ? leadsPercent : null,
          t.targetDeals > 0 ? dealsPercent : null,
          t.targetCalls > 0 ? callsPercent : null,
          t.targetMeetings > 0 ? meetingsPercent : null,
        ].filter(v => v !== null);
        const overall = activePercentages.length > 0
          ? Math.round(activePercentages.reduce((a, b) => a + b, 0) / activePercentages.length)
          : 0;

        let finalStatus = t.status;
        if (overall >= 100 && t.status !== "Completed" && t.status !== "Rejected") {
          finalStatus = "Completed";
          await Target.findByIdAndUpdate(t._id, { status: "Completed" });
        } else if (overall < 100 && t.status === "Completed") {
          finalStatus = "In Progress";
          await Target.findByIdAndUpdate(t._id, { status: "In Progress" });
        }

        return {
          ...t,
          status: finalStatus,
          linkedLeads: existingLeads,
          linkedDeals: existingDeals,
          convertedLeadDeals,
          actuals,
          percentages: { leadsPercent, dealsPercent, callsPercent, meetingsPercent, overall, effTargetLeads, effTargetDeals, leadDealWonPercent },
        };
      }));

      res.status(200).json(result);
    } catch (err) {
      console.error("Error fetching linked targets:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: get all targets with progress
  getTargets: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied: Admins only" });
      }
      const models = getModels(req);
      const { Target } = models;

      const { Lead, Deal } = models;
      // Step 1: lean fetch to get raw ObjectIds for accurate counting
      const allRawTargets = await Target.find()
        .populate("salesPerson", "firstName lastName email")
        .populate("createdBy", "firstName lastName email")
        .populate("notes.addedBy", "firstName lastName")
        .sort({ createdAt: -1 })
        .lean();

      // A target whose salesPerson user was deleted (populate leaves it
      // null) would otherwise throw inside the map below and reject the
      // WHOLE Promise.all — taking every other sales person's target down
      // with it, so admin's Task Management ends up showing "No active
      // target set" for everyone. Skip just the broken one instead.
      const rawTargets = allRawTargets.filter((t) => {
        if (!t.salesPerson) console.error(`Target ${t._id} has no resolvable salesPerson (deleted user?) — skipping`);
        return !!t.salesPerson;
      });

      const result = await Promise.all(rawTargets.map(async (t) => {
        const rawLeadIds = (t.linkedLeads || []);
        const rawDealIds = (t.linkedDeals || []);

        const hadSpecificLeads = t.reasonNotes && t.reasonNotes.some(r => r.itemType === "lead");
        const hadSpecificDeals = t.reasonNotes && t.reasonNotes.some(r => r.itemType === "deal");

        // Counts use raw IDs (works even for deleted leads)
        const actuals = await computeActuals(models, t.salesPerson._id, t.startDate, t.endDate, rawLeadIds, rawDealIds, t.targetLeads, t.targetDeals, (t.reportedCalls || []).length, (t.reportedMeetings || []).length, hadSpecificLeads, hadSpecificDeals);

        // Populate existing leads (deleted ones are simply absent)
        const existingLeads = await Lead.find({ _id: { $in: rawLeadIds } })
          .select("leadName companyName phoneNumber email status createdAt statusHistory")
          .lean();

        const spIdStr = String(t.salesPerson._id || t.salesPerson);

        // Deals created from converted linked leads (carry status history)
        const convertedLeadDealsRole = { path: "convertedBy", select: "firstName lastName role", populate: { path: "role", select: "name" } };
        const wonByRole = { path: "wonBy", select: "firstName lastName role", populate: { path: "role", select: "name" } };

        const convertedLeadDeals = await Deal.find({ leadId: { $in: rawLeadIds } })
          .select("dealName leadId convertedAt convertedBy assignedTo createdAt stage value currency leadStatusHistory leadCreatedAt stageHistory lossReason lossNotes stageLostAt updatedAt companyName phoneNumber email wonAt wonBy")
          .populate(convertedLeadDealsRole)
          .populate(STAGE_HISTORY_MOVER_POPULATE)
          .lean()
          .then(deals => deals.map(d => {
            const isSPConverted = d.convertedBy
              ? String(d.convertedBy._id || d.convertedBy) === spIdStr
              : String(d.assignedTo || "") === spIdStr;
            // Always carry the converter's name — the frontend picks the wording
            // ("Admin X converted..." vs "X converted...") based on salesPersonConverted.
            const convertedByName = d.convertedBy
              ? `${d.convertedBy.firstName || ""} ${d.convertedBy.lastName || ""}`.trim()
              : null;
            return {
              ...d,
              salesPersonConverted: isSPConverted,
              convertedByName,
              takenByAdminName: getTakenByAdminName(d.stageHistory, String(d.assignedTo || spIdStr)),
            };
          }));

        // Populate linked deals (full stageHistory — all stage moves shown in journey)
        const existingDeals = await Deal.find({ _id: { $in: rawDealIds } })
          .select("dealName dealTitle companyName phoneNumber email stage value currency wonAt wonBy convertedAt convertedBy assignedTo createdAt stageHistory lossReason lossNotes stageLostAt updatedAt")
          .populate(convertedLeadDealsRole)
          .populate(wonByRole)
          .populate(STAGE_HISTORY_MOVER_POPULATE)
          .lean()
          .then(deals => deals.map(d => {
            const takenByAdminName = getTakenByAdminName(d.stageHistory, String(d.assignedTo || spIdStr));
            if (!d.convertedBy) return { ...d, salesPersonConverted: null, convertedByName: null, takenByAdminName };
            const isSPConverted = String(d.convertedBy._id || d.convertedBy) === spIdStr;
            return {
              ...d,
              salesPersonConverted: isSPConverted,
              convertedByName: `${d.convertedBy.firstName || ""} ${d.convertedBy.lastName || ""}`.trim(),
              takenByAdminName,
            };
          }));

        // Overwrites removed because computeActuals handles it

        // How many of THIS target's own linked leads/deals did Admin close
        // out personally — see effectiveGoal() above for why this shrinks
        // the denominator instead of just being excluded from the numerator.
        const adminConvertedLeadsCount = convertedLeadDeals.filter(d => d.convertedBy?.role?.name === "Admin").length;
        const adminWonDealsCount = existingDeals.filter(d => d.stage === "Closed Won" && d.wonBy?.role?.name === "Admin").length;

        const effTargetLeads = effectiveGoal(t.targetLeads, rawLeadIds.length, adminConvertedLeadsCount);
        const effTargetDeals = effectiveGoal(t.targetDeals, rawDealIds.length, adminWonDealsCount);

        const leadsPercent = effTargetLeads > 0 
          ? Math.min(100, Math.round((actuals.leadsConverted / effTargetLeads) * 100)) 
          : (t.targetLeads > 0 && adminConvertedLeadsCount >= rawLeadIds.length && rawLeadIds.length > 0 ? 100 : 0);
        const dealsPercent = effTargetDeals > 0 
          ? Math.min(100, Math.round((actuals.dealsWon / effTargetDeals) * 100)) 
          : (t.targetDeals > 0 && adminWonDealsCount >= rawDealIds.length && rawDealIds.length > 0 ? 100 : 0);
        const leadDealWonPercent = effTargetLeads > 0 
          ? Math.min(100, Math.round((actuals.leadDealWon / effTargetLeads) * 100)) 
          : (t.targetLeads > 0 && adminConvertedLeadsCount >= rawLeadIds.length && rawLeadIds.length > 0 ? 100 : 0);
        const callsPercent = t.targetCalls > 0 ? Math.min(100, Math.round((actuals.calls / t.targetCalls) * 100)) : 0;
        const meetingsPercent = t.targetMeetings > 0 ? Math.min(100, Math.round((actuals.meetings / t.targetMeetings) * 100)) : 0;
        const activePercentages = [
          t.targetLeads > 0 ? leadsPercent : null,
          t.targetDeals > 0 ? dealsPercent : null,
          t.targetCalls > 0 ? callsPercent : null,
          t.targetMeetings > 0 ? meetingsPercent : null,
        ].filter(v => v !== null);
        const overall = activePercentages.length > 0
          ? Math.round(activePercentages.reduce((a, b) => a + b, 0) / activePercentages.length)
          : 0;

        let finalStatus = t.status;
        if (t.status !== "In Hold" && t.status !== "Rejected") {
          if (overall >= 100 && t.status !== "Completed") {
            finalStatus = "Completed";
            await Target.findByIdAndUpdate(t._id, { status: "Completed" });
          } else if (overall > 0 && overall < 100 && (t.status === "New" || t.status === "Pending")) {
            finalStatus = "In Progress";
            await Target.findByIdAndUpdate(t._id, { status: "In Progress" });
          } else if (overall === 0 && t.status === "In Progress") {
            finalStatus = "New";
            await Target.findByIdAndUpdate(t._id, { status: "New" });
          } else if (overall < 100 && t.status === "Completed") {
            finalStatus = "In Progress";
            await Target.findByIdAndUpdate(t._id, { status: "In Progress" });
          }
        }

        return {
          ...t,
          status: finalStatus,
          linkedLeads: existingLeads,
          linkedDeals: existingDeals,
          convertedLeadDeals,
          actuals,
          percentages: { leadsPercent, dealsPercent, callsPercent, meetingsPercent, overall, effTargetLeads, effTargetDeals, leadDealWonPercent },
        };
      }));

      res.status(200).json(result);
    } catch (err) {
      console.error("Error fetching targets:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Sales: get only their own targets with progress
  getMyTargets: async (req, res) => {
    try {
      const models = getModels(req);
      const { Target } = models;

      const { Lead, Deal } = models;
      console.log("[getMyTargets] userId:", String(req.user._id));
      const rawTargets = await Target.find({ salesPerson: req.user._id })
        .populate("salesPerson", "firstName lastName email")
        .populate("createdBy", "firstName lastName email")
        .populate("notes.addedBy", "firstName lastName")
        .sort({ createdAt: -1 })
        .lean();

      console.log("[getMyTargets] rawTargets found:", rawTargets.length);
      const result = await Promise.all(rawTargets.map(async (t) => {
        const rawLeadIds = (t.linkedLeads || []);
        const rawDealIds = (t.linkedDeals || []);

        const hadSpecificLeads = t.reasonNotes && t.reasonNotes.some(r => r.itemType === "lead");
        const hadSpecificDeals = t.reasonNotes && t.reasonNotes.some(r => r.itemType === "deal");

        const actuals = await computeActuals(models, req.user._id, t.startDate, t.endDate, rawLeadIds, rawDealIds, t.targetLeads, t.targetDeals, (t.reportedCalls || []).length, (t.reportedMeetings || []).length, hadSpecificLeads, hadSpecificDeals);

        const existingLeads = await Lead.find({ _id: { $in: rawLeadIds } })
          .select("leadName companyName phoneNumber email status createdAt statusHistory")
          .lean();

        const myIdStr = String(req.user._id);

        const myConvertedLeadDealsRole = { path: "convertedBy", select: "firstName lastName role", populate: { path: "role", select: "name" } };
        const myWonByRole = { path: "wonBy", select: "firstName lastName role", populate: { path: "role", select: "name" } };

        const convertedLeadDeals = await Deal.find({ leadId: { $in: rawLeadIds } })
          .select("dealName leadId convertedAt convertedBy assignedTo createdAt stage value currency leadStatusHistory leadCreatedAt stageHistory lossReason lossNotes stageLostAt updatedAt companyName phoneNumber email wonAt wonBy")
          .populate(myConvertedLeadDealsRole)
          .populate(STAGE_HISTORY_MOVER_POPULATE)
          .lean()
          .then(deals => deals.map(d => {
            const isSPConverted = d.convertedBy
              ? String(d.convertedBy._id || d.convertedBy) === myIdStr
              : String(d.assignedTo || "") === myIdStr;
            const convertedByName = d.convertedBy
              ? `${d.convertedBy.firstName || ""} ${d.convertedBy.lastName || ""}`.trim()
              : null;
            return {
              ...d,
              salesPersonConverted: isSPConverted,
              convertedByName,
              takenByAdminName: getTakenByAdminName(d.stageHistory, String(d.assignedTo || myIdStr)),
            };
          }));

        const existingDeals = await Deal.find({ _id: { $in: rawDealIds } })
          .select("dealName dealTitle companyName phoneNumber email stage value currency wonAt wonBy convertedAt convertedBy assignedTo createdAt stageHistory lossReason lossNotes stageLostAt updatedAt")
          .populate(myConvertedLeadDealsRole)
          .populate(myWonByRole)
          .populate(STAGE_HISTORY_MOVER_POPULATE)
          .lean()
          .then(deals => deals.map(d => {
            const takenByAdminName = getTakenByAdminName(d.stageHistory, String(d.assignedTo || myIdStr));
            if (!d.convertedBy) return { ...d, salesPersonConverted: null, convertedByName: null, takenByAdminName };
            const isSPConverted = String(d.convertedBy._id || d.convertedBy) === myIdStr;
            return {
              ...d,
              salesPersonConverted: isSPConverted,
              convertedByName: `${d.convertedBy.firstName || ""} ${d.convertedBy.lastName || ""}`.trim(),
              takenByAdminName,
            };
          }));

        // Overwrites removed because computeActuals handles it

        // Same admin-took-this-specific-item denominator shrink as getTargets
        // above — see effectiveGoal().
        const adminConvertedLeadsCount = convertedLeadDeals.filter(d => d.convertedBy?.role?.name === "Admin").length;
        const adminWonDealsCount = existingDeals.filter(d => d.stage === "Closed Won" && d.wonBy?.role?.name === "Admin").length;

        const effTargetLeads = effectiveGoal(t.targetLeads, rawLeadIds.length, adminConvertedLeadsCount);
        const effTargetDeals = effectiveGoal(t.targetDeals, rawDealIds.length, adminWonDealsCount);

        const leadsPercent = effTargetLeads > 0 
          ? Math.min(100, Math.round((actuals.leadsConverted / effTargetLeads) * 100)) 
          : (t.targetLeads > 0 && adminConvertedLeadsCount >= rawLeadIds.length && rawLeadIds.length > 0 ? 100 : 0);
        const dealsPercent = effTargetDeals > 0 
          ? Math.min(100, Math.round((actuals.dealsWon / effTargetDeals) * 100)) 
          : (t.targetDeals > 0 && adminWonDealsCount >= rawDealIds.length && rawDealIds.length > 0 ? 100 : 0);
        const leadDealWonPercent = effTargetLeads > 0 
          ? Math.min(100, Math.round((actuals.leadDealWon / effTargetLeads) * 100)) 
          : (t.targetLeads > 0 && adminConvertedLeadsCount >= rawLeadIds.length && rawLeadIds.length > 0 ? 100 : 0);
        const callsPercent = t.targetCalls > 0 ? Math.min(100, Math.round((actuals.calls / t.targetCalls) * 100)) : 0;
        const meetingsPercent = t.targetMeetings > 0 ? Math.min(100, Math.round((actuals.meetings / t.targetMeetings) * 100)) : 0;
        const activePercentages = [
          t.targetLeads > 0 ? leadsPercent : null,
          t.targetDeals > 0 ? dealsPercent : null,
          t.targetCalls > 0 ? callsPercent : null,
          t.targetMeetings > 0 ? meetingsPercent : null,
        ].filter(v => v !== null);
        const overall = activePercentages.length > 0
          ? Math.round(activePercentages.reduce((a, b) => a + b, 0) / activePercentages.length)
          : 0;

        let finalStatus = t.status;
        if (t.status !== "Rejected") {
          if (t.status === "In Hold") {
            if (t.holdSnapshotProgress == null) {
              t.holdSnapshotProgress = overall;
              await Target.findByIdAndUpdate(t._id, { holdSnapshotProgress: overall });
            } else if (overall > t.holdSnapshotProgress) {
              if (overall >= 100) {
                finalStatus = "Completed";
                await Target.findByIdAndUpdate(t._id, { status: "Completed", holdSnapshotProgress: null });
              } else {
                finalStatus = "In Progress";
                await Target.findByIdAndUpdate(t._id, { status: "In Progress", holdSnapshotProgress: null });
              }
            }
          } else {
            if (overall >= 100 && t.status !== "Completed") {
              finalStatus = "Completed";
              await Target.findByIdAndUpdate(t._id, { status: "Completed" });
            } else if (overall > 0 && overall < 100 && (t.status === "New" || t.status === "Pending")) {
              finalStatus = "In Progress";
              await Target.findByIdAndUpdate(t._id, { status: "In Progress" });
            } else if (overall === 0 && t.status === "In Progress") {
              finalStatus = "New";
              await Target.findByIdAndUpdate(t._id, { status: "New" });
            } else if (overall < 100 && t.status === "Completed") {
              finalStatus = "In Progress";
              await Target.findByIdAndUpdate(t._id, { status: "In Progress" });
            }
          }
        }

        return {
          ...t,
          status: finalStatus,
          linkedLeads: existingLeads,
          linkedDeals: existingDeals,
          convertedLeadDeals,
          actuals,
          percentages: { leadsPercent, dealsPercent, callsPercent, meetingsPercent, overall, effTargetLeads, effTargetDeals, leadDealWonPercent },
        };
      }));

      res.status(200).json(result);
    } catch (err) {
      console.error("Error fetching my targets:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: get a specific sales person's detailed lead/deal data for the modal preview
  getSalesPersonSummary: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied: Admins only" });
      }
      const models = getModels(req);
      const { Lead, Deal, Target, Task } = models;
      const { userId } = req.params;

      const [leads, deals, activeTargets, pendingTasks] = await Promise.all([
        // Rejected leads are dead ends and Converted leads have already become
        // a Deal (shown below via the Deals query instead) — neither belongs
        // in this "pick leads to link" list.
        Lead.find({ assignTo: userId })
          .select("leadName companyName phoneNumber email status createdAt updatedAt")
          .sort({ createdAt: -1 }),
        Deal.find({ assignedTo: userId })
          .select("dealName dealTitle stage value currency companyName phoneNumber email createdAt updatedAt wonAt convertedAt convertedBy stageHistory lossReason lossNotes stageLostAt")
          .populate("convertedBy", "firstName lastName")
          .populate(STAGE_HISTORY_MOVER_POPULATE)
          .sort({ createdAt: -1 }),
        Target.find({ salesPerson: userId, endDate: { $gte: new Date() } }).select("linkedLeads linkedDeals convertedLeadDeals"),
        Task.find({ assignedTo: userId, status: { $ne: "Completed" } }).select("leadRef dealRef leadRefs dealRefs")
      ]);

      const inTargetLeadIds = new Set();
      const inTargetDealIds = new Set();
      activeTargets.forEach(t => {
        (t.linkedLeads || []).forEach(id => inTargetLeadIds.add(String(id._id || id)));
        (t.linkedDeals || []).forEach(id => inTargetDealIds.add(String(id._id || id)));
        (t.convertedLeadDeals || []).forEach(id => inTargetDealIds.add(String(id._id || id)));
      });

      const inTaskLeadIds = new Set();
      const inTaskDealIds = new Set();
      pendingTasks.forEach(t => {
        if (t.leadRef) inTaskLeadIds.add(String(t.leadRef._id || t.leadRef));
        if (t.dealRef) inTaskDealIds.add(String(t.dealRef._id || t.dealRef));
        (t.leadRefs || []).forEach(id => inTaskLeadIds.add(String(id._id || id)));
        (t.dealRefs || []).forEach(id => inTaskDealIds.add(String(id._id || id)));
      });

      // Group leads by status
      const leadsByStatus = leads.reduce((acc, l) => {
        acc[l.status] = (acc[l.status] || 0) + 1;
        return acc;
      }, {});

      // Group deals by stage
      const dealsByStage = deals.reduce((acc, d) => {
        acc[d.stage] = (acc[d.stage] || 0) + 1;
        return acc;
      }, {});

      // Enrich won deals with days taken + admin-conversion attribution
      const enrichedDeals = deals.map((d) => {
        const obj = d.toObject();
        if (d.stage === "Closed Won" && d.wonAt) {
          const start = new Date(d.createdAt);
          const end = new Date(d.wonAt);
          const diffMs = end - start;
          const days = Math.max(0, Math.round(diffMs / (1000 * 60 * 60 * 24)));
          obj.daysTaken = days;
          obj.wonAtFormatted = end.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
        }
        if (obj.convertedBy) {
          obj.salesPersonConverted = String(obj.convertedBy._id || obj.convertedBy) === String(userId);
          obj.convertedByName = `${obj.convertedBy.firstName || ""} ${obj.convertedBy.lastName || ""}`.trim();
        } else {
          obj.salesPersonConverted = null;
          obj.convertedByName = null;
        }
        obj.takenByAdminName = getTakenByAdminName(obj.stageHistory, String(userId));
        return obj;
      });

      res.status(200).json({
        leads: {
          total: leads.length,
          byStatus: leadsByStatus,
          list: leads.map((l) => ({
            _id: l._id,
            leadName: l.leadName,
            companyName: l.companyName,
            phoneNumber: l.phoneNumber,
            email: l.email,
            status: l.status,
            createdAt: l.createdAt,
            inActiveTarget: inTargetLeadIds.has(String(l._id)),
            inActiveTask: inTaskLeadIds.has(String(l._id)),
          })),
        },
        deals: {
          total: deals.length,
          byStage: dealsByStage,
          list: enrichedDeals.map((d) => ({
            _id: d._id,
            dealName: d.dealName || d.dealTitle,
            companyName: d.companyName,
            phoneNumber: d.phoneNumber,
            email: d.email,
            stage: d.stage,
            value: d.value,
            currency: d.currency || "INR",
            createdAt: d.createdAt,
            wonAt: d.wonAt,
            wonAtFormatted: d.wonAtFormatted,
            daysTaken: d.daysTaken,
            stageHistory: d.stageHistory,
            lossReason: d.lossReason,
            lossNotes: d.lossNotes,
            stageLostAt: d.stageLostAt,
            salesPersonConverted: d.salesPersonConverted,
            convertedByName: d.convertedByName,
            takenByAdminName: d.takenByAdminName,
            inActiveTarget: inTargetDealIds.has(String(d._id)),
            inActiveTask: inTaskDealIds.has(String(d._id)),
          })),
        },
      });
    } catch (err) {
      console.error("Error fetching sales person summary:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: create target for a sales person
  createTarget: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied: Admins only" });
      }
      const { Target, Notification } = getModels(req);
      const { title, salesPerson, period, startDate, endDate, targetLeads, targetDeals, targetCalls, targetMeetings, linkedLeads, linkedDeals, description } = req.body;

      const dateError = validateTargetDates(startDate, endDate, { isCreate: true });
      if (dateError) return res.status(400).json({ message: dateError });

      const target = await Target.create({
        title: title || "Untitled Target",
        salesPerson,
        period,
        startDate,
        endDate,
        description: description || "",
        targetLeads: targetLeads || 0,
        targetDeals: targetDeals || 0,
        targetCalls: targetCalls || 0,
        targetMeetings: targetMeetings || 0,
        linkedLeads: linkedLeads || [],
        linkedDeals: linkedDeals || [],
        createdBy: req.user._id,
      });

      const populated = await target.populate([
        { path: "salesPerson", select: "firstName lastName email" },
        { path: "createdBy", select: "firstName lastName email" },
        { path: "linkedLeads", select: "leadName companyName phoneNumber email status" },
        { path: "linkedDeals", select: "dealName dealTitle companyName phoneNumber email stage value currency wonAt" },
      ]);

      // Notify the assigned sales person
      const adminName = `${req.user.firstName} ${req.user.lastName}`;
      const periodLabel = period === "weekly" ? "weekly" : "monthly";
      const descSuffix = description?.trim() ? ` Message from admin: "${description.trim()}"` : "";
      await createNotification(Notification, {
        userId: salesPerson,
        title: "New Target Assigned",
        message: `Admin ${adminName} set a new ${periodLabel} target for you.${descSuffix} Check My Targets to see the details.`,
        type: "target",
        meta: { targetId: String(target._id), targetAssigned: true },
      });

      // Real-time: notify sales person + all admins to refresh immediately
      notifyTargetUser(String(salesPerson), "targets_refresh", {});
      try {
        const { User, Role } = getModels(req);
        const admins = await findAdmins(User, Role);
        admins.forEach(a => notifyTargetUser(String(a._id), "targets_refresh", {}));
      } catch (_) {}

      // Check immediately in case the deadline is already tomorrow/today — don't
      // make the admin/sales person wait for the next periodic cron tick.
      checkTargetDeadlineNow(target._id, req.tenantDB).catch(() => {});

      res.status(201).json({ message: "Target created successfully", data: populated });
    } catch (err) {
      console.error("Error creating target:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: update target
  updateTarget: async (req, res) => {
    try {
      const { Target, Notification } = getModels(req);
      const isAdmin = req.user.role?.name === "Admin";
      
      const existing = await Target.findById(req.params.id).select("startDate endDate salesPerson status").lean();
      if (!existing) return res.status(404).json({ message: "Target not found" });

      if (!isAdmin && String(existing.salesPerson) !== String(req.user._id)) {
        return res.status(403).json({ message: "Access denied" });
      }

      let updatePayload = { ...req.body };

      if (!isAdmin) {
        updatePayload = {
          status: req.body.status,
          inProcessNote: req.body.inProcessNote,
        };

        if (req.body.status === "Rejected") {
          updatePayload.status = existing.status;
          updatePayload.rejectionRequested = true;
          updatePayload.rejectionReason = req.body.rejectionReason || "";
        }
        
        if (req.body.status === "In Hold") {
          updatePayload.status = existing.status;
          updatePayload.holdRequested = true;
          updatePayload.holdReason = req.body.holdReason || "";
          updatePayload.holdRequestedAt = new Date();
        }
      }
      const { startDate, endDate } = req.body;
      let endDateChanged = false;
      if (startDate || endDate) {
        const existing = await Target.findById(req.params.id).select("startDate endDate").lean();
        if (!existing) return res.status(404).json({ message: "Target not found" });
        const dateError = validateTargetDates(
          startDate || existing.startDate,
          endDate || existing.endDate,
          { isCreate: false }
        );
        if (dateError) return res.status(400).json({ message: dateError });

        if (isAdmin && endDate && new Date(endDate).getTime() !== new Date(existing.endDate).getTime()) {
          endDateChanged = true;
          updatePayload.reminderSentAt = null;
          updatePayload.dueTodaySentAt = null;
          updatePayload.expiredAt = null;
        }
      }

      const updated = await Target.findByIdAndUpdate(req.params.id, updatePayload, {
        new: true,
        runValidators: true,
      }).populate("salesPerson", "firstName lastName email")
        .populate("linkedLeads", "leadName")
        .populate("linkedDeals", "dealName dealTitle");

      if (!updated) return res.status(404).json({ message: "Target not found" });

      // Build lead/deal name summary for notification
      const leadNames = (updated.linkedLeads || []).map(l => l.leadName).filter(Boolean);
      const dealNames = (updated.linkedDeals || []).map(d => d.dealName || d.dealTitle).filter(Boolean);
      const parts = [];
      if (leadNames.length > 0) parts.push(`Leads: ${leadNames.slice(0, 3).join(", ")}${leadNames.length > 3 ? ` +${leadNames.length - 3} more` : ""}`);
      if (dealNames.length > 0) parts.push(`Deals: ${dealNames.slice(0, 3).join(", ")}${dealNames.length > 3 ? ` +${dealNames.length - 3} more` : ""}`);
      const detailSuffix = parts.length > 0 ? ` (${parts.join(" | ")})` : "";

      const adminName = `${req.user.firstName} ${req.user.lastName}`;
      const updDescSuffix = updated.description?.trim() ? ` Message from admin: "${updated.description.trim()}"` : "";
      
      if (isAdmin) {
        await createNotification(Notification, {
          userId: updated.salesPerson._id,
          title: "Target Updated",
          message: `Admin ${adminName} updated your target${detailSuffix}.${updDescSuffix} Check My Targets for the latest details.`,
          type: "target",
          meta: { targetId: String(updated._id), targetUpdated: true },
        });
      } else {
        // Salesperson updated their own target. Notify admin if they requested rejection or added note
        const { User, Role } = getModels(req);
        const admins = await findAdmins(User, Role);
        const rejectionRequested = updatePayload.rejectionRequested;
        const holdRequested = updatePayload.holdRequested;
        const statusChanged = req.body.status && req.body.status !== existing.status && !rejectionRequested && !holdRequested;
        
        for (const admin of admins) {
          if (rejectionRequested) {
            await createNotification(Notification, {
              userId: admin._id,
              title: "Target Rejection Requested",
              message: `${adminName} requested to reject target${detailSuffix}. Reason: ${req.body.rejectionReason}`,
              type: "target",
              meta: { targetId: String(updated._id), targetRejectionRequested: true },
            });
          } else if (holdRequested) {
            await createNotification(Notification, {
              userId: admin._id,
              title: "Target Hold Requested",
              message: `${adminName} requested to place target${detailSuffix} on hold. Reason: ${req.body.holdReason}`,
              type: "target",
              meta: { targetId: String(updated._id), targetHoldRequested: true },
            });
          } else if (statusChanged) {
            await createNotification(Notification, {
              userId: admin._id,
              title: "Target Status Changed",
              message: `${adminName} changed target status to ${req.body.status}. Note: ${req.body.inProcessNote || "None"}`,
              type: "target",
              meta: { targetId: String(updated._id), targetStatusChanged: true },
            });
          }
        }
      }

      if (endDateChanged) {
        checkTargetDeadlineNow(updated._id, req.tenantDB).catch(() => {});
      }

      res.status(200).json({ message: "Target updated", data: updated });
    } catch (err) {
      console.error("Error updating target:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: approve or deny a target rejection request
  approveRejection: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied: Admins only" });
      }
      const { Target, Notification } = getModels(req);
      const { action } = req.body; // "approve" or "deny"
      const target = await Target.findById(req.params.id);
      if (!target) return res.status(404).json({ message: "Target not found" });

      const adminName = `${req.user.firstName} ${req.user.lastName}`;
      let updatePayload = {};
      let message = "";

      if (action === "approve") {
        updatePayload = {
          status: "Rejected",
          rejectionRequested: false,
          rejectionApprovedAt: new Date(),
        };
        message = `Admin ${adminName} approved your request to reject target.`;
      } else {
        updatePayload = {
          rejectionRequested: false,
          rejectionReason: "",
        };
        message = `Admin ${adminName} denied your request to reject target.`;
      }

      const updated = await Target.findByIdAndUpdate(req.params.id, updatePayload, { new: true })
        .populate("salesPerson", "firstName lastName email");

      // Notify the salesperson
      await createNotification(Notification, {
        userId: target.salesPerson._id,
        title: action === "approve" ? "Target Rejection Approved" : "Target Rejection Denied",
        message,
        type: "target",
        meta: { targetId: String(target._id), targetRejectionAction: action },
      });

      notifyTargetUser(String(target.salesPerson), "targets_refresh", {});
      res.status(200).json({ message: `Rejection ${action}d successfully`, data: updated });
    } catch (err) {
      console.error("Error handling rejection request:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: approve or deny a hold request
  approveHold: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied: Admins only" });
      }
      const { Target, Notification } = getModels(req);
      const { action, extendDueDate } = req.body; // "approve" or "deny"
      const target = await Target.findById(req.params.id);
      if (!target) return res.status(404).json({ message: "Target not found" });

      const adminName = `${req.user.firstName} ${req.user.lastName}`;
      let updatePayload = {};
      let message = "";

      if (action === "approve") {
        updatePayload = {
          status: "In Hold",
          holdRequested: false,
          holdApprovedAt: new Date(),
        };
        if (extendDueDate) {
          updatePayload.endDate = new Date(extendDueDate);
          updatePayload.reminderSentAt = null;
          updatePayload.dueTodaySentAt = null;
          updatePayload.expiredAt = null;
        }
        message = `Admin ${adminName} approved your request to place target on hold.`;
      } else {
        updatePayload = {
          holdRequested: false,
          holdReason: "",
        };
        message = `Admin ${adminName} denied your request to place target on hold.`;
      }

      const updated = await Target.findByIdAndUpdate(req.params.id, updatePayload, { new: true })
        .populate("salesPerson", "firstName lastName email");

      // Notify the salesperson
      await createNotification(Notification, {
        userId: target.salesPerson._id,
        title: action === "approve" ? "Target Hold Approved" : "Target Hold Denied",
        message,
        type: "target",
        meta: { targetId: String(target._id), targetHoldAction: action },
      });

      notifyTargetUser(String(target.salesPerson), "targets_refresh", {});
      res.status(200).json({ message: `Hold ${action}d successfully`, data: updated });
    } catch (err) {
      console.error("Error handling hold request:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: unlink any lead/deal from a target. Sales: unlink only their own
  // already-completed items (Closed Won/Lost deals, Converted leads) — a
  // self-service way to clear finished cards, not to hide active work.
  unlinkItem: async (req, res) => {
    try {
      const { Target, Lead, Deal } = getModels(req);
      const { id } = req.params;
      const { type, itemId } = req.body; // type: "lead" | "deal"
      if (!type || !itemId) return res.status(400).json({ message: "type and itemId are required" });

      const isAdmin = req.user.role?.name === "Admin";
      if (!isAdmin) {
        const target = await Target.findById(id).select("salesPerson");
        if (!target) return res.status(404).json({ message: "Target not found" });
        if (String(target.salesPerson) !== String(req.user._id)) {
          return res.status(403).json({ message: "Access denied" });
        }

        if (type === "deal") {
          const deal = await Deal.findById(itemId).select("stage");
          const completed = deal && (deal.stage === "Closed Won" || deal.stage === "Closed Lost");
          if (!completed) return res.status(403).json({ message: "You can only remove completed deals" });
        } else {
          const lead = await Lead.findById(itemId).select("status");
          // A missing Lead document means it was already converted to a deal (completed)
          const completed = !lead || lead.status === "Converted";
          if (!completed) return res.status(403).json({ message: "You can only remove completed leads" });
        }
      }

      const field = type === "lead" ? "linkedLeads" : "linkedDeals";
      const countField = type === "lead" ? "targetLeads" : "targetDeals";

      // Removing a tracked item also shrinks the goal count it counted toward —
      // otherwise unlinking a completed (Closed Won/Converted) item drags the
      // percentage down instead of leaving it correctly at 100%.
      const before = await Target.findById(id).select(countField);
      if (!before) return res.status(404).json({ message: "Target not found" });
      const updateOp = { $pull: { [field]: itemId } };
      if ((before[countField] || 0) > 0) updateOp.$inc = { [countField]: -1 };

      const updated = await Target.findByIdAndUpdate(id, updateOp, { new: true });
      if (!updated) return res.status(404).json({ message: "Target not found" });

      notifyTargetUser(String(updated.salesPerson), "targets_refresh", {});
      const { User, Role } = getModels(req);
      try {
        const admins = await findAdmins(User, Role);
        admins.forEach(a => notifyTargetUser(String(a._id), "targets_refresh", {}));
      } catch (_) {}

      res.status(200).json({ message: "Item unlinked successfully" });
    } catch (err) {
      console.error("Error unlinking item:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: delete target
  deleteTarget: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied: Admins only" });
      }
      const { Target, User, Role } = getModels(req);
      const deleted = await Target.findByIdAndDelete(req.params.id);
      if (!deleted) return res.status(404).json({ message: "Target not found" });

      // Real-time: tell the sales person to instantly remove this card
      notifyTargetUser(String(deleted.salesPerson), "target_deleted", { targetId: String(deleted._id) });
      notifyTargetUser(String(deleted.salesPerson), "targets_refresh", {});
      try {
        const admins = await findAdmins(User, Role);
        admins.forEach(a => notifyTargetUser(String(a._id), "targets_refresh", {}));
      } catch (_) {}

      // Clean up related notifications
      const { Notification } = getModels(req);
      let objectId = null;
      try { objectId = new mongoose.Types.ObjectId(req.params.id); } catch {}
      const query = objectId
        ? { $or: [{ "meta.targetId": req.params.id }, { "meta.targetId": objectId }] }
        : { "meta.targetId": req.params.id };

      const relatedNotifs = await Notification.find(query).select("_id userId");
      if (relatedNotifs.length > 0) {
        const notifIds = relatedNotifs.map((n) => n._id);
        await Notification.deleteMany({ _id: { $in: notifIds } });
        // The targets_refresh event above will typically cause the client to refetch anyway,
        // but we can also emit the exact deleted event if needed.
      }

      res.status(200).json({ message: "Target deleted successfully" });
    } catch (err) {
      console.error("Error deleting target:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: summary stats for dashboard
  getDashboardStats: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied: Admins only" });
      }
      const models = getModels(req);
      const { Lead, Deal, CallLog, Activity } = models;

      const { period, startDate, endDate } = req.query;
      
      let dateFilterCreatedAt = {};
      let dateFilterUpdatedAt = {};
      let dateFilterStartDate = {};

      if (period === "this_month") {
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        dateFilterCreatedAt = { createdAt: { $gte: monthStart } };
        dateFilterUpdatedAt = { updatedAt: { $gte: monthStart } };
        dateFilterStartDate = { startDate: { $gte: monthStart } };
      } else if (period === "custom" && startDate && endDate) {
        const start = new Date(startDate);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        dateFilterCreatedAt = { createdAt: { $gte: start, $lte: end } };
        dateFilterUpdatedAt = { updatedAt: { $gte: start, $lte: end } };
        dateFilterStartDate = { startDate: { $gte: start, $lte: end } };
      }
      // if period === "all", the filters remain empty {}

      // Keep week filters for the weekly stats object (which isn't affected by the new filter)
      const now = new Date();
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - now.getDay());

      const [
        totalLeadsCreated,
        activeLeads,
        convertedLeads,
        totalDealsCreated,
        activeDeals,
        wonDeals,
        lostDeals,
        monthCalls,
        monthMeetings,
        weekCalls,
        weekMeetings,
      ] = await Promise.all([
        Lead.countDocuments({ ...dateFilterCreatedAt }),
        Lead.countDocuments({ ...dateFilterCreatedAt, status: { $nin: ["Converted", "Rejected"] } }),
        Lead.countDocuments({ status: "Converted", ...dateFilterUpdatedAt }),
        Deal.countDocuments({ ...dateFilterCreatedAt }),
        Deal.countDocuments({ ...dateFilterCreatedAt, stage: { $nin: ["Closed Won", "Closed Lost"] } }),
        Deal.countDocuments({ stage: "Closed Won", ...dateFilterUpdatedAt }),
        Deal.countDocuments({ stage: "Closed Lost", ...dateFilterUpdatedAt }),
        CallLog.countDocuments({ userId: { $exists: true }, ...dateFilterCreatedAt }),
        Activity.countDocuments({ activityCategory: "Meeting", ...dateFilterStartDate }),
        CallLog.countDocuments({ userId: { $exists: true }, createdAt: { $gte: weekStart } }),
        Activity.countDocuments({ activityCategory: "Meeting", startDate: { $gte: weekStart } }),
      ]);

      res.status(200).json({
        monthly: { // kept as 'monthly' for backwards compatibility in frontend
          totalLeads: totalLeadsCreated,
          convertedLeads,
          leadToDealRate: totalLeadsCreated > 0 ? Math.round((convertedLeads / totalLeadsCreated) * 100) : 0,
          totalDeals: totalDealsCreated,
          wonDeals,
          lostDeals,
          calls: monthCalls,
          meetings: monthMeetings,
        },
        weekly: {
          calls: weekCalls,
          meetings: weekMeetings,
        },
      });
    } catch (err) {
      console.error("Error fetching dashboard stats:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Sales: same shape as getDashboardStats, but scoped to the logged-in
  // sales person's own leads/deals/calls/meetings — powers My Tasks's own
  // "My Monthly Overview" widget so it always shows real numbers, even with
  // zero active Targets (a Target-derived sum shows nothing in that case).
  getMyDashboardStats: async (req, res) => {
    try {
      const models = getModels(req);
      const { Lead, Deal, CallLog, Activity } = models;
      const userId = req.user._id;

      const { period, startDate, endDate } = req.query;
      
      let dateFilterCreatedAt = {};
      let dateFilterUpdatedAt = {};
      let dateFilterStartDate = {};

      if (period === "this_month") {
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        dateFilterCreatedAt = { createdAt: { $gte: monthStart } };
        dateFilterUpdatedAt = { updatedAt: { $gte: monthStart } };
        dateFilterStartDate = { startDate: { $gte: monthStart } };
      } else if (period === "custom" && startDate && endDate) {
        const start = new Date(startDate);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        dateFilterCreatedAt = { createdAt: { $gte: start, $lte: end } };
        dateFilterUpdatedAt = { updatedAt: { $gte: start, $lte: end } };
        dateFilterStartDate = { startDate: { $gte: start, $lte: end } };
      }
      
      const now = new Date();
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - now.getDay());

      const [
        totalLeadsCreated,
        activeLeads,
        convertedLeads,
        totalDealsCreated,
        activeDeals,
        wonDeals,
        lostDeals,
        monthCalls,
        monthMeetings,
        weekCalls,
        weekMeetings,
      ] = await Promise.all([
        Lead.countDocuments({ assignTo: userId, ...dateFilterCreatedAt }),
        Lead.countDocuments({ assignTo: userId, ...dateFilterCreatedAt, status: { $nin: ["Converted", "Rejected"] } }),
        Lead.countDocuments({ assignTo: userId, status: "Converted", ...dateFilterUpdatedAt }),
        Deal.countDocuments({ assignedTo: userId, ...dateFilterCreatedAt }),
        Deal.countDocuments({ assignedTo: userId, ...dateFilterCreatedAt, stage: { $nin: ["Closed Won", "Closed Lost"] } }),
        Deal.countDocuments({ assignedTo: userId, stage: "Closed Won", ...dateFilterUpdatedAt }),
        Deal.countDocuments({ assignedTo: userId, stage: "Closed Lost", ...dateFilterUpdatedAt }),
        CallLog.countDocuments({ userId, ...dateFilterCreatedAt }),
        Activity.countDocuments({ userId, activityCategory: "Meeting", ...dateFilterStartDate }),
        CallLog.countDocuments({ userId, createdAt: { $gte: weekStart } }),
        Activity.countDocuments({ userId, activityCategory: "Meeting", startDate: { $gte: weekStart } }),
      ]);

      res.status(200).json({
        monthly: {
          totalLeads: totalLeadsCreated,
          convertedLeads,
          leadToDealRate: totalLeadsCreated > 0 ? Math.round((convertedLeads / totalLeadsCreated) * 100) : 0,
          totalDeals: totalDealsCreated,
          wonDeals,
          lostDeals,
          calls: monthCalls,
          meetings: monthMeetings,
        },
        weekly: {
          calls: weekCalls,
          meetings: weekMeetings,
        },
      });
    } catch (err) {
      console.error("Error fetching my dashboard stats:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Sales: their own fallback Progress-card snapshot for tasks where they
  // have no Target covering it yet — see computeFallbackSnapshotsForTasks
  // above. Keyed by taskId (not flattened to one aggregate), so each task
  // card only ever shows progress from its OWN linked lead/deal.
  getMyProgressFallback: async (req, res) => {
    try {
      const models = getModels(req);
      const { Task } = models;
      const myTasks = await Task.find({ assignedTo: req.user._id, archived: { $ne: true } })
        .select("leadRef dealRef")
        .lean();
      const snapshot = await computeFallbackSnapshotsForTasks(models, req.user._id, myTasks);
      res.status(200).json(snapshot);
    } catch (err) {
      console.error("Error fetching my progress fallback:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: same fallback snapshots, but batched for every Sales-role user in
  // one call — powers Task Management's Progress card for any task whose
  // assignee has no Target covering it, without an N+1 fetch per task card.
  // Flattened into one object keyed by taskId (not by userId) so a lookup by
  // task._id always gets that task's own scoped numbers.
  getProgressFallbackAll: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied: Admins only" });
      }
      const models = getModels(req);
      const { User, Role, Task } = models;
      // Non-Admin, same rule the salesPerson picker in Target Management's
      // create-target form already uses — role name varies per tenant, only
      // "not Admin" is guaranteed.
      const adminRole = await Role.findOne({ name: "Admin" });
      const salesUsers = await User.find({ role: { $ne: adminRole?._id } }).select("_id").lean();

      const allTasks = await Task.find({ archived: { $ne: true } }).select("assignedTo leadRef dealRef").lean();
      const tasksByUser = new Map();
      for (const t of allTasks) {
        const uid = String(t.assignedTo);
        if (!tasksByUser.has(uid)) tasksByUser.set(uid, []);
        tasksByUser.get(uid).push(t);
      }

      const perUserMaps = await Promise.all(
        salesUsers.map((u) => computeFallbackSnapshotsForTasks(models, u._id, tasksByUser.get(String(u._id)) || []))
      );
      res.status(200).json(Object.assign({}, ...perUserMaps));
    } catch (err) {
      console.error("Error fetching progress fallback for all sales users:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Sales: add a note to their target (visible to admin)
  addNote: async (req, res) => {
    try {
      const { Target, Notification, User, Role } = getModels(req);
      const { text } = req.body;
      if (!text?.trim()) return res.status(400).json({ message: "Note text is required" });

      const target = await Target.findById(req.params.id);
      if (!target) return res.status(404).json({ message: "Target not found" });

      // Only the assigned sales person can add notes
      if (String(target.salesPerson) !== String(req.user._id) && req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied" });
      }

      target.notes.push({ text: text.trim(), addedBy: req.user._id, addedAt: new Date() });
      await target.save();

      // Notify all admins
      const adminRole = await Role.findOne({ name: "Admin" });
      if (adminRole) {
        const admins = await User.find({ role: adminRole._id, status: "Active" }).select("_id");
        const salesName = `${req.user.firstName} ${req.user.lastName}`;
        await Promise.all(
          admins.map(admin =>
            createNotification(Notification, {
              userId: admin._id,
              title: "Note from Sales Person",
              message: `${salesName} added a note to their target: "${text.trim().substring(0, 80)}${text.length > 80 ? "..." : ""}"`,
              type: "target",
              meta: { targetId: String(target._id), noteAdded: true },
            })
          )
        );
      }

      res.status(200).json({ message: "Note added", notes: target.notes });
    } catch (err) {
      console.error("Error adding note:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Sales: flag a lead/deal with a reason note (visible to admin)
  addReasonNote: async (req, res) => {
    try {
      const fs = (await import('fs')).default;
      const logFile = "d:/SAAS_CRM_BACKEND/debug.log";
      fs.appendFileSync(logFile, "\n--- addReasonNote started for Target ---\n");

      const { Target, Notification, User, Role } = getModels(req);
      const { itemType, itemId, itemName, note, companyName, phoneNumber, email, value, currency, stageOrStatus } = req.body;
      fs.appendFileSync(logFile, `Req body: ${JSON.stringify(req.body)}\n`);

      if (!note?.trim()) return res.status(400).json({ message: "Note is required" });
      if (!["lead", "deal", "target"].includes(itemType)) return res.status(400).json({ message: "itemType must be lead, deal, or target" });

      const target = await Target.findById(req.params.id);
      if (!target) return res.status(404).json({ message: "Target not found" });
      if (String(target.salesPerson) !== String(req.user._id) && req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied" });
      }

      target.reasonNotes.push({
        itemType,
        itemId,
        itemName,
        note: note.trim(),
        addedBy: req.user._id,
        addedAt: new Date(),
        status: "pending",
        companyName: companyName || "",
        phoneNumber: phoneNumber || "",
        email: email || "",
        value: value ? String(value) : "",
        currency: currency || "",
        stageOrStatus: stageOrStatus || "",
      });
      fs.appendFileSync(logFile, "Saving target...\n");
      await target.save();
      fs.appendFileSync(logFile, "Target saved!\n");

      // Notify all admins
      const adminRole = await Role.findOne({ name: "Admin" });
      if (adminRole) {
        const admins = await User.find({ role: adminRole._id, status: "Active" }).select("_id");
        const salesName = `${req.user.firstName} ${req.user.lastName}`;
        await Promise.all(
          admins.map(admin =>
            createNotification(Notification, {
              userId: admin._id,
              title: "Reason Note from Sales Person",
              message: `${salesName} reported an issue with ${itemType} "${itemName}": "${note.trim().substring(0, 100)}${note.length > 100 ? "..." : ""}"`,
              type: "reason_note",
              meta: { targetId: String(target._id), itemType, itemId: String(itemId), itemName, reasonNote: true },
            })
          )
        );
        // Socket notify admins immediately
        admins.forEach(a => notifyTargetUser(String(a._id), "reason_note_received", {
          targetId: String(target._id), salesName, itemType, itemName, note: note.trim(),
        }));
      }

      res.status(200).json({ message: "Reason note sent to admin", reasonNotes: target.reasonNotes });
      fs.appendFileSync(logFile, "Success sent.\n");
    } catch (err) {
      const fs = (await import('fs')).default;
      fs.appendFileSync("d:/SAAS_CRM_BACKEND/debug.log", `ERROR in addReasonNote target: ${err.stack}\n`);
      console.error("Error adding reason note:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: mark a reason note as read (resolved) without reassigning
  markReasonNoteRead: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") return res.status(403).json({ message: "Access denied" });
      const { Target } = getModels(req);
      const { noteIdx } = req.params;

      const target = await Target.findById(req.params.id);
      if (!target) return res.status(404).json({ message: "Target not found" });

      const rn = target.reasonNotes[Number(noteIdx)];
      if (!rn) return res.status(404).json({ message: "Reason note not found" });

      target.reasonNotes[Number(noteIdx)].status = "resolved";
      target.reasonNotes[Number(noteIdx)].resolvedAt = new Date();
      await target.save();

      res.status(200).json({
        message: "Marked as read",
        data: { _id: String(target._id), reasonNotes: target.reasonNotes },
      });
    } catch (err) {
      console.error("Error marking target reason note as read:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: get all pending reason notes across all targets
  getAllReasonNotes: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") return res.status(403).json({ message: "Access denied" });
      const { Target, Task } = getModels(req);
      const targets = await Target.find({ "reasonNotes.0": { $exists: true } })
        .populate("salesPerson", "firstName lastName email")
        .populate("reasonNotes.addedBy", "firstName lastName")
        .populate("reasonNotes.reassignedTo", "firstName lastName")
        .populate("linkedLeads", "status")
        .populate("linkedDeals", "stage")
        .lean();

      const allSalesPersonIds = [...new Set(targets.map(t => String(t.salesPerson._id)))];
      const activeTasks = await Task.find({
        assignedTo: { $in: allSalesPersonIds },
        status: { $nin: ["Completed", "Closed", "Rejected"] }
      }).lean();

      const allNotes = [];
      for (const t of targets) {
        const remainingLeads = (t.linkedLeads || []).filter(l => l && l.status !== "Converted");
        const remainingDeals = (t.linkedDeals || []).filter(d => d && d.stage !== "Closed Won" && d.stage !== "Closed Lost");
        const remainingCallsCount = Math.max(0, (t.targetCalls || 0) - (t.reportedCalls || []).length);
        const remainingMeetingsCount = Math.max(0, (t.targetMeetings || 0) - (t.reportedMeetings || []).length);

        const userTasks = activeTasks.filter(task => String(task.assignedTo) === String(t.salesPerson._id));
        const overlappingTaskLeads = [];
        const overlappingTaskDeals = [];

        remainingLeads.forEach(lead => {
          const leadIdStr = String(lead._id);
          const foundTask = userTasks.find(task => 
            (task.leadRef && String(task.leadRef) === leadIdStr) || 
            (task.leadRefs && task.leadRefs.some(ref => String(ref) === leadIdStr))
          );
          if (foundTask) overlappingTaskLeads.push({ _id: lead._id, name: lead.leadName, taskId: foundTask._id, taskTitle: foundTask.title });
        });

        remainingDeals.forEach(deal => {
          const dealIdStr = String(deal._id);
          const foundTask = userTasks.find(task => 
            (task.dealRef && String(task.dealRef) === dealIdStr) || 
            (task.dealRefs && task.dealRefs.some(ref => String(ref) === dealIdStr))
          );
          if (foundTask) overlappingTaskDeals.push({ _id: deal._id, name: deal.dealName || deal.dealTitle, taskId: foundTask._id, taskTitle: foundTask.title });
        });

        for (let i = 0; i < t.reasonNotes.length; i++) {
          allNotes.push({ 
            ...t.reasonNotes[i], 
            noteIdx: i, 
            targetId: t._id, 
            salesPerson: t.salesPerson,
            remainingLeadsCount: remainingLeads.length,
            remainingDealsCount: remainingDeals.length,
            remainingCallsCount,
            remainingMeetingsCount,
            remainingLeads,
            remainingDeals,
            overlappingTaskLeads,
            overlappingTaskDeals
          });
        }
      }
      allNotes.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
      res.status(200).json(allNotes);
    } catch (err) {
      console.error("Error fetching reason notes:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: reassign a lead or deal to another sales person (from reason note)
  reassignItem: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") return res.status(403).json({ message: "Access denied" });
      const { Target, Lead, Deal, Notification, User } = getModels(req);
      const { noteIdx } = req.params;
      const { reassignToUserId, adminNote, extendEndDate } = req.body;

      const target = await Target.findById(req.params.id).populate("salesPerson", "firstName lastName");
      if (!target) return res.status(404).json({ message: "Target not found" });

      const rn = target.reasonNotes[Number(noteIdx)];
      if (!rn) return res.status(404).json({ message: "Reason note not found" });

      const newUser = await User.findById(reassignToUserId).select("firstName lastName");
      if (!newUser) return res.status(404).json({ message: "User not found" });

      const isSamePerson = String(target.salesPerson._id) === String(reassignToUserId);
      const adminName = `${req.user.firstName} ${req.user.lastName}`;
      const oldSalesName = `${target.salesPerson?.firstName} ${target.salesPerson?.lastName}`;
      const motivationalQuotes = [
        "Every expert was once a beginner. This is your chance to shine!",
        "Hard work beats talent when talent doesn't work hard. Go get it!",
        "Success is not given, it's earned. Give it everything you've got!",
        "Champions aren't made in the gym. They are made from things they carry inside them. Go close this one!",
        "The harder you work for something, the greater you'll feel when you achieve it. You've got this!",
        "Believe you can and you're halfway there. Go make it happen!",
        "Don't watch the clock — do what it does. Keep going!",
      ];
      const quote = motivationalQuotes[Math.floor(Math.random() * motivationalQuotes.length)];

      if (isSamePerson) {
        // Same person — mark note as reactivated so the card becomes editable again
        target.reasonNotes[Number(noteIdx)].status = "reactivated";
        target.reasonNotes[Number(noteIdx)].resolvedAt = new Date();
        target.reasonNotes[Number(noteIdx)].reassignedTo = reassignToUserId;
        target.reasonNotes[Number(noteIdx)].reassignNote = adminNote || "";

        // Auto-expired items are unlinked from the target before their reason note
        // is created — re-link here so "kept with same person" actually restores tracking.
        if (rn.itemType === "lead") {
          if (!target.linkedLeads.some(id => String(id) === String(rn.itemId))) {
            target.linkedLeads.push(rn.itemId);
          }
        } else if (rn.itemType === "deal") {
          if (!target.linkedDeals.some(id => String(id) === String(rn.itemId))) {
            target.linkedDeals.push(rn.itemId);
          }
        }

        // Re-enable the item itself — it was disabled (read-only) while pending reassignment
        if (rn.itemType === "lead") await Lead.findByIdAndUpdate(rn.itemId, { isActive: true });
        else if (rn.itemType === "deal") await Deal.findByIdAndUpdate(rn.itemId, { isActive: true });
        else if (rn.itemType === "target") target.status = "In Progress";

        // Extending the due date for the same person must also restart the
        // reminder cycle, otherwise the cron thinks it already notified for
        // this target and stays silent until the (now stale) old deadline.
        if (extendEndDate) {
          target.endDate = new Date(extendEndDate);
          target.reminderSentAt = null; 
          target.dueTodaySentAt = null;
          target.expiredAt = null;
        }

        await target.save();

        await createNotification(Notification, {
          userId: target.salesPerson._id,
          title: `${rn.itemType === "lead" ? "Lead" : "Deal"} Still Yours — Keep Going!`,
          message: `Admin ${adminName} reviewed "${rn.itemName}" and kept it with you.${adminNote ? ` Note: ${adminNote}` : ""} ${quote}`,
          type: "target_reassign",
          meta: { targetId: String(target._id), itemType: rn.itemType, itemId: String(rn.itemId), itemName: rn.itemName, reactivated: true },
        });
        notifyTargetUser(String(target.salesPerson._id), "item_reactivated", {
          itemType: rn.itemType, itemName: rn.itemName, itemId: String(rn.itemId), quote,
        });
      } else {
        // ── Different person ──────────────────────────────────────────────
        console.log("[reassignItem] DIFFERENT PERSON branch. reassignToUserId:", String(reassignToUserId));
        console.log("[reassignItem] itemType:", rn.itemType, "itemId:", String(rn.itemId), "itemName:", rn.itemName);

        // 1. Re-assign lead/deal ownership + remove from original target
        let sourceLeadId = null; // populated when deal is a converted-lead-deal
        const oldAssigneeId = String(target.salesPerson._id);
        let skipNewTargetCreation = false;

        if (rn.itemType === "lead") {
          // Re-assigning to a different person also re-enables the item for
          // its new owner — it was disabled (read-only) on the old owner's view.
          await Lead.findByIdAndUpdate(rn.itemId, { assignTo: reassignToUserId, isActive: true });
          target.linkedLeads = target.linkedLeads.filter(id => String(id) !== String(rn.itemId));
        } else if (rn.itemType === "deal") {
          await Deal.findByIdAndUpdate(rn.itemId, { assignedTo: reassignToUserId, isActive: true });
          target.linkedDeals = target.linkedDeals.filter(id => String(id) !== String(rn.itemId));
          // Also handle converted-lead-deals: the source lead sits in linkedLeads, not linkedDeals
          const dealDoc = await Deal.findById(rn.itemId).select("leadId").lean();
          if (dealDoc?.leadId) {
            sourceLeadId = String(dealDoc.leadId);
            target.linkedLeads = target.linkedLeads.filter(id => String(id) !== sourceLeadId);
            console.log("[reassignItem] Converted-lead-deal — removed source lead:", sourceLeadId);
          }
        } else if (rn.itemType === "target") {
          // Reassigning the overall target itself to a new person
          
          const actuals = await computeActuals(
            getModels(req), 
            oldAssigneeId, 
            target.startDate, 
            target.endDate, 
            target.linkedLeads, 
            target.linkedDeals, 
            target.targetLeads, 
            target.targetDeals, 
            (target.reportedCalls || []).length, 
            (target.reportedMeetings || []).length, 
            target.linkedLeads && target.linkedLeads.length > 0, 
            target.linkedDeals && target.linkedDeals.length > 0
          );
          
          const leadsData = await Lead.find({ _id: { $in: target.linkedLeads } }).select("status");
          const completedLeads = [];
          const remainingLeads = [];
          for (const l of leadsData) {
            if (l.status === "Converted") completedLeads.push(l._id);
            else remainingLeads.push(l._id);
          }

          const dealsData = await Deal.find({ _id: { $in: target.linkedDeals } }).select("stage");
          const completedDeals = [];
          const remainingDeals = [];
          for (const d of dealsData) {
            if (d.stage === "Closed Won" || d.stage === "Closed Lost") completedDeals.push(d._id);
            else remainingDeals.push(d._id);
          }

          const totalActuals = actuals.leadsConverted + actuals.dealsWon + actuals.calls + actuals.meetings;
          
          if (totalActuals > 0 || completedLeads.length > 0 || completedDeals.length > 0) {
            // SPLIT TARGET
            // Store original goals for the new target
            req._splitRemainder = {
              targetLeads: Math.max(0, target.targetLeads - actuals.leadsConverted),
              targetDeals: Math.max(0, target.targetDeals - actuals.dealsWon),
              targetCalls: Math.max(0, target.targetCalls - actuals.calls),
              targetMeetings: Math.max(0, target.targetMeetings - actuals.meetings),
              linkedLeads: remainingLeads,
              linkedDeals: remainingDeals
            };
            
            // Old target stays with old assignee, scaled down to actuals
            target.targetLeads = actuals.leadsConverted;
            target.targetDeals = actuals.dealsWon;
            target.targetCalls = actuals.calls;
            target.targetMeetings = actuals.meetings;
            target.linkedLeads = completedLeads;
            target.linkedDeals = completedDeals;
            target.status = "Completed";
            
            skipNewTargetCreation = false;
          } else {
            // Nothing completed, reassign fully
            target.salesPerson = reassignToUserId;
            skipNewTargetCreation = true;
            if (extendEndDate) {
              target.endDate = new Date(extendEndDate);
              target.reminderSentAt = null;
              target.dueTodaySentAt = null;
              target.expiredAt = null;
            }
          }
        }
        target.reasonNotes[Number(noteIdx)].status      = "resolved";
        target.reasonNotes[Number(noteIdx)].resolvedAt  = new Date();
        target.reasonNotes[Number(noteIdx)].reassignedTo = reassignToUserId;
        target.reasonNotes[Number(noteIdx)].reassignNote = adminNote || "";
        await target.save();
        console.log("[reassignItem] Original target saved — item removed.");

        // 2. Create a new target for the new sales person (unless it's the target itself being reassigned entirely)
        if (!skipNewTargetCreation) {
          const resolvedEndDate = extendEndDate ? new Date(extendEndDate) : null;
  
          const createPayload = {
            title:          target.title || "Untitled Target",
            salesPerson:    reassignToUserId,
            period:         target.period,
            startDate:      target.startDate,
            endDate:        resolvedEndDate || target.endDate,
            targetLeads:    rn.itemType === "target" ? req._splitRemainder.targetLeads : 0,
            targetDeals:    rn.itemType === "target" ? req._splitRemainder.targetDeals : 0,
            targetCalls:    rn.itemType === "target" ? req._splitRemainder.targetCalls : 0,
            targetMeetings: rn.itemType === "target" ? req._splitRemainder.targetMeetings : 0,
            description:    `Assigned by admin — ${rn.itemType}: ${rn.itemName}`,
            createdBy:      req.user._id,
            linkedLeads:    rn.itemType === "target" ? req._splitRemainder.linkedLeads : (rn.itemType === "lead" ? [rn.itemId] : []),
            linkedDeals:    rn.itemType === "target" ? req._splitRemainder.linkedDeals : (rn.itemType === "deal" ? [rn.itemId] : []),
          };
          console.log("[reassignItem] Creating new target with payload:", JSON.stringify(createPayload));
          const receiverTarget = await Target.create(createPayload);
          console.log("[reassignItem] New target created — id:", String(receiverTarget._id));
        }

        // 2.5 Cascading Task Split
        const { Task } = getModels(req);
        const transferredLeadIdsStr = new Set((rn.itemType === "target" ? (req._splitRemainder?.linkedLeads || remainingLeads || []) : (rn.itemType === "lead" ? [rn.itemId] : [])).map(String));
        const transferredDealIdsStr = new Set((rn.itemType === "target" ? (req._splitRemainder?.linkedDeals || remainingDeals || []) : (rn.itemType === "deal" ? [rn.itemId] : [])).map(String));
        
        if (transferredLeadIdsStr.size > 0 || transferredDealIdsStr.size > 0) {
          const activeTasks = await Task.find({
            assignedTo: oldAssigneeId,
            status: { $nin: ["Completed", "Closed", "Rejected"] }
          });
          
          for (const t of activeTasks) {
            const tLeads = (t.leadRefs || []).map(String);
            const tDeals = (t.dealRefs || []).map(String);
            
            const hasOverlap = tLeads.some(l => transferredLeadIdsStr.has(l)) || tDeals.some(d => transferredDealIdsStr.has(d));
            
            if (hasOverlap) {
              const completedLeadsForTask = [];
              const remainingLeadsForTask = [];
              const tLeadsData = await Lead.find({ _id: { $in: t.leadRefs } }).select("status");
              for (const l of tLeadsData) {
                if (l.status === "Converted") completedLeadsForTask.push(l._id);
                else remainingLeadsForTask.push(l._id);
              }

              const completedDealsForTask = [];
              const remainingDealsForTask = [];
              const tDealsData = await Deal.find({ _id: { $in: t.dealRefs } }).select("stage");
              for (const d of tDealsData) {
                if (d.stage === "Closed Won" || d.stage === "Closed Lost") completedDealsForTask.push(d._id);
                else remainingDealsForTask.push(d._id);
              }

              if (completedLeadsForTask.length > 0 || completedDealsForTask.length > 0) {
                t.leadRefs = completedLeadsForTask;
                t.dealRefs = completedDealsForTask;
                t.leadRef = completedLeadsForTask.length > 0 ? completedLeadsForTask[completedLeadsForTask.length - 1] : null;
                t.dealRef = completedDealsForTask.length > 0 ? completedDealsForTask[completedDealsForTask.length - 1] : null;
                t.status = "Completed";
                t.approvedByAdmin = true;
                t.history.push({
                  event: "TaskSplit",
                  detail: `Task split due to overlapping Target reassignment by Admin ${adminName}.`,
                  by: req.user._id,
                  at: new Date(),
                });
                await t.save();

                if (remainingLeadsForTask.length > 0) await Lead.updateMany({ _id: { $in: remainingLeadsForTask } }, { assignTo: reassignToUserId });
                if (remainingDealsForTask.length > 0) await Deal.updateMany({ _id: { $in: remainingDealsForTask } }, { assignedTo: reassignToUserId });

                const newTask = new Task({
                  title: t.title,
                  description: t.description,
                  priority: t.priority,
                  dueDate: extendEndDate ? new Date(extendEndDate) : t.dueDate,
                  assignedTo: reassignToUserId,
                  createdBy: t.createdBy,
                  leadRefs: remainingLeadsForTask,
                  dealRefs: remainingDealsForTask,
                  leadRef: remainingLeadsForTask.length > 0 ? remainingLeadsForTask[remainingLeadsForTask.length - 1] : null,
                  dealRef: remainingDealsForTask.length > 0 ? remainingDealsForTask[remainingDealsForTask.length - 1] : null,
                  leadDueDates: t.leadDueDates,
                  dealDueDates: t.dealDueDates,
                  status: "Pending",
                  history: [{
                    event: "Created",
                    detail: `Created from split task "${t.title}" cascaded from Target reassignment.`,
                    by: req.user._id,
                    at: new Date()
                  }]
                });
                await newTask.save();
              } else {
                t.leadRefs = remainingLeadsForTask;
                t.dealRefs = remainingDealsForTask;
                t.assignedTo = reassignToUserId;
                t.markModified("assignedTo");
                t.reminderSentAt = null;
                t.dueTodaySentAt = null;
                if (extendEndDate) t.dueDate = new Date(extendEndDate);
                t.history.push({
                  event: "Reassigned",
                  detail: `Cascaded reassignment from Target by Admin ${adminName}.`,
                  by: req.user._id,
                  at: new Date(),
                });
                if (remainingLeadsForTask.length > 0) await Lead.updateMany({ _id: { $in: remainingLeadsForTask } }, { assignTo: reassignToUserId });
                if (remainingDealsForTask.length > 0) await Deal.updateMany({ _id: { $in: remainingDealsForTask } }, { assignedTo: reassignToUserId });
                await t.save();
              }
            }
          }
        }

        // 3. Notifications
        await createNotification(Notification, {
          userId: reassignToUserId,
          title:   rn.itemType === "target" ? "Target Reassigned to You" : `New ${rn.itemType === "lead" ? "Lead" : "Deal"} Assigned to You`,
          message: `Admin ${adminName} assigned "${rn.itemName}" to you. ${quote}`,
          type:    "target_reassign",
          meta:    { itemType: rn.itemType, itemId: String(rn.itemId), itemName: rn.itemName },
        });
        await createNotification(Notification, {
          userId:  oldAssigneeId,
          title:   rn.itemType === "target" ? "Target Reassigned" : `${rn.itemType === "lead" ? "Lead" : "Deal"} Reassigned`,
          message: `Admin ${adminName} assigned "${rn.itemName}" to ${newUser.firstName} ${newUser.lastName}.${adminNote ? ` Note: ${adminNote}` : ""} You did well! ${quote}`,
          type:    "target_reassign",
          meta:    { itemType: rn.itemType, itemId: String(rn.itemId), itemName: rn.itemName, removed: true },
        });

        // 4. Real-time events
        notifyTargetUser(String(reassignToUserId),      "item_reassigned",  { itemType: rn.itemType, itemName: rn.itemName, quote });
        notifyTargetUser(String(reassignToUserId),      "targets_refresh",  {});
        notifyTargetUser(String(oldAssigneeId),         "item_removed",     { itemType: rn.itemType, itemName: rn.itemName, itemId: String(rn.itemId), sourceLeadId, targetId: String(target._id) });
        notifyTargetUser(String(oldAssigneeId),         "targets_refresh",  {});

        // Notify all admins to refresh their view
        try {
          const { Role } = getModels(req);
          const admins = await findAdmins(User, Role);
          admins.forEach(a => notifyTargetUser(String(a._id), "targets_refresh", {}));
        } catch (_) { /* non-critical */ }
      }

      res.status(200).json({ message: isSamePerson ? "Item reactivated for same sales person" : "Item reassigned successfully" });
    } catch (err) {
      console.error("Error reassigning item:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  rejectReasonNote: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") return res.status(403).json({ message: "Access denied" });
      const { Target, Notification } = getModels(req);
      const { noteIdx } = req.params;
      const { rejectReason } = req.body;

      const target = await Target.findById(req.params.id).populate("salesPerson", "firstName lastName _id");
      if (!target) return res.status(404).json({ message: "Target not found" });

      const nIdx = parseInt(noteIdx, 10);
      if (isNaN(nIdx) || nIdx < 0 || nIdx >= target.reasonNotes.length) {
        return res.status(400).json({ message: "Invalid note index" });
      }

      const rn = target.reasonNotes[nIdx];
      if (rn.status !== "pending") {
        return res.status(400).json({ message: "Reason note is not pending" });
      }

      rn.status = "rejected";
      rn.rejectReason = rejectReason || "";
      rn.resolvedAt = new Date();
      await target.save();

      const adminName = `${req.user.firstName} ${req.user.lastName}`;
      if (target.salesPerson) {
        const itemText = rn.itemName ? `${rn.itemType === "deal" ? "Deal" : "Lead"} "${rn.itemName}"` : "your delayed item";
        await createNotification(Notification, {
          userId: target.salesPerson._id,
          title: "Delay Reason Rejected",
          message: `Admin ${adminName} rejected your delay reason for ${itemText}.${rejectReason ? ` Admin note: ${rejectReason}` : ""}\nPlease submit a new valid reason.`,
          type: "target",
          meta: { targetId: String(target._id), targetReasonRejected: true },
        });
        notifyTargetUser(String(target.salesPerson._id), "targets_refresh", {});
      }

      res.status(200).json({ message: "Reason note rejected" });
    } catch (error) {
      console.error("[rejectReasonNote] error:", error);
      res.status(500).json({ message: "Server Error", error: error.message });
    }
  },

  // Admin: proactively reassign ALL still-incomplete leads/deals linked to a
  // target — used from the "Tomorrow"/"Today" due-date notifications, before
  // anything has expired (so there's no reasonNotes entry yet to key off of).
  reassignTargetItems: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") return res.status(403).json({ message: "Access denied" });
      const { Target, Lead, Deal, Notification, User, Role } = getModels(req);
      const { reassignToUserId, adminNote, extendEndDate } = req.body;

      const targetLean = await Target.findById(req.params.id)
        .populate("salesPerson", "firstName lastName")
        .populate("linkedLeads", "leadName status")
        .populate("linkedDeals", "dealName dealTitle stage")
        .lean();
      if (!targetLean) return res.status(404).json({ message: "Target not found" });

      const newUser = await User.findById(reassignToUserId).select("firstName lastName");
      if (!newUser) return res.status(404).json({ message: "User not found" });

      const incompleteLeads = (targetLean.linkedLeads || []).filter((l) => l.status !== "Converted");
      const incompleteDeals = (targetLean.linkedDeals || []).filter((d) => d.stage !== "Closed Won");
      if (!incompleteLeads.length && !incompleteDeals.length) {
        return res.status(400).json({ message: "Nothing left to reassign — all linked items are already complete" });
      }

      const isSamePerson = String(targetLean.salesPerson._id) === String(reassignToUserId);
      const adminName = `${req.user.firstName} ${req.user.lastName}`;
      const oldSalesName = `${targetLean.salesPerson.firstName} ${targetLean.salesPerson.lastName}`;
      const resolvedEndDate = extendEndDate ? new Date(extendEndDate) : null;
      const leadIds = incompleteLeads.map((l) => l._id);
      const dealIds = incompleteDeals.map((d) => d._id);

      // Mark the Tomorrow/Today due-date notifications for this target as
      // resolved everywhere they appear, so the "Reassign" button on them
      // turns into a completed indicator instead of staying clickable.
      await Notification.updateMany(
        { type: { $in: ["target_reminder", "target_due_today"] }, "meta.targetId": String(targetLean._id) },
        { $set: { "meta.resolved": true, "meta.resolvedToName": `${newUser.firstName} ${newUser.lastName}`, "meta.resolvedAt": new Date() } }
      );

      if (isSamePerson) {
        // Extending the due date must also restart the reminder cycle, otherwise
        // the cron thinks it already notified for this target and stays silent.
        if (resolvedEndDate) {
          await Target.findByIdAndUpdate(targetLean._id, {
            endDate: resolvedEndDate, reminderSentAt: null, dueTodaySentAt: null, expiredAt: null,
          });
        }
        if (leadIds.length) await Lead.updateMany({ _id: { $in: leadIds } }, { isActive: true });
        if (dealIds.length) await Deal.updateMany({ _id: { $in: dealIds } }, { isActive: true });

        await createNotification(Notification, {
          userId: targetLean.salesPerson._id,
          title: "Deadline Extended",
          message: `Admin ${adminName} gave you more time on your current leads/deals.${resolvedEndDate ? ` New due date: ${resolvedEndDate.toDateString()}.` : ""}${adminNote ? ` Note: ${adminNote}` : ""}`,
          type: "target_reassign",
          meta: { targetId: String(targetLean._id) },
        });
        notifyTargetUser(String(targetLean.salesPerson._id), "targets_refresh", {});
        try {
          const admins = await findAdmins(User, Role);
          admins.forEach((a) => notifyTargetUser(String(a._id), "target_due_today", {}));
        } catch (_) { /* non-critical */ }
      } else {
        // Split the target: the old target retains completed items, the new target gets the remaining items
        const oldAssigneeId = String(targetLean.salesPerson._id);
        let skipNewTargetCreation = false;

        const actuals = await computeActuals(
          getModels(req),
          oldAssigneeId,
          targetLean.startDate,
          targetLean.endDate,
          (targetLean.linkedLeads || []).map(l => l._id),
          (targetLean.linkedDeals || []).map(d => d._id),
          targetLean.targetLeads,
          targetLean.targetDeals,
          (targetLean.reportedCalls || []).length,
          (targetLean.reportedMeetings || []).length,
          targetLean.linkedLeads && targetLean.linkedLeads.length > 0,
          targetLean.linkedDeals && targetLean.linkedDeals.length > 0
        );

        const completedLeads = [];
        const remainingLeads = [];
        for (const l of (targetLean.linkedLeads || [])) {
          if (l.status === "Converted") completedLeads.push(l._id);
          else remainingLeads.push(l._id);
        }

        const completedDeals = [];
        const remainingDeals = [];
        for (const d of (targetLean.linkedDeals || [])) {
          if (d.stage === "Closed Won" || d.stage === "Closed Lost") completedDeals.push(d._id);
          else remainingDeals.push(d._id);
        }

        const totalActuals = actuals.leadsConverted + actuals.dealsWon + actuals.calls + actuals.meetings;
        
        let splitRemainder = { targetLeads: 0, targetDeals: 0, targetCalls: 0, targetMeetings: 0 };
        
        if (totalActuals > 0 || completedLeads.length > 0 || completedDeals.length > 0) {
          // SPLIT TARGET
          splitRemainder = {
            targetLeads: Math.max(0, targetLean.targetLeads - actuals.leadsConverted),
            targetDeals: Math.max(0, targetLean.targetDeals - actuals.dealsWon),
            targetCalls: Math.max(0, targetLean.targetCalls - actuals.calls),
            targetMeetings: Math.max(0, targetLean.targetMeetings - actuals.meetings),
            linkedLeads: remainingLeads,
            linkedDeals: remainingDeals
          };
          
          // Old target stays with old assignee, scaled down to actuals
          await Target.findByIdAndUpdate(targetLean._id, {
            targetLeads: actuals.leadsConverted,
            targetDeals: actuals.dealsWon,
            targetCalls: actuals.calls,
            targetMeetings: actuals.meetings,
            linkedLeads: completedLeads,
            linkedDeals: completedDeals,
            status: "Completed",
          });
          
          skipNewTargetCreation = false;
        } else {
          // Nothing completed, reassign fully
          await Target.findByIdAndUpdate(targetLean._id, {
            salesPerson: reassignToUserId,
            endDate: resolvedEndDate || targetLean.endDate,
            reminderSentAt: null,
            dueTodaySentAt: null,
            expiredAt: null
          });
          skipNewTargetCreation = true;
        }

        if (leadIds.length) await Lead.updateMany({ _id: { $in: leadIds } }, { assignTo: reassignToUserId, isActive: true });
        if (dealIds.length) await Deal.updateMany({ _id: { $in: dealIds } }, { assignedTo: reassignToUserId, isActive: true });

        let receiverTargetId = String(targetLean._id);
        if (!skipNewTargetCreation) {
          // ALWAYS create a new target for the new sales person so it appears as "New"
          const receiverTarget = await Target.create({
            salesPerson:    reassignToUserId,
            period:         targetLean.period,
            startDate:      targetLean.startDate,
            endDate:        resolvedEndDate || targetLean.endDate,
            targetLeads:    splitRemainder.targetLeads,
            targetDeals:    splitRemainder.targetDeals,
            targetCalls:    splitRemainder.targetCalls,
            targetMeetings: splitRemainder.targetMeetings,
            description:    `Assigned by admin — reassigned from ${oldSalesName}'s target`,
            createdBy:      req.user._id,
            linkedLeads:    leadIds,
            linkedDeals:    dealIds,
          });
          receiverTargetId = String(receiverTarget._id);
        }

        const itemSummary = [...incompleteLeads.map((l) => l.leadName), ...incompleteDeals.map((d) => d.dealName || d.dealTitle)].join(", ");

        await createNotification(Notification, {
          userId: reassignToUserId,
          title:  skipNewTargetCreation ? "Target Reassigned to You" : "New Leads/Deals Assigned to You",
          message: `Admin ${adminName} assigned these to you: ${itemSummary}.${adminNote ? ` Note: ${adminNote}` : ""}`,
          type:   "target_reassign",
          meta:   { targetId: receiverTargetId },
        });
        await createNotification(Notification, {
          userId: targetLean.salesPerson._id,
          title:  skipNewTargetCreation ? "Target Reassigned" : "Leads/Deals Reassigned",
          message: `Admin ${adminName} reassigned these to ${newUser.firstName} ${newUser.lastName}: ${itemSummary}.${adminNote ? ` Note: ${adminNote}` : ""}`,
          type:   "target_reassign",
          meta:   { targetId: String(targetLean._id), removed: true },
        });

        notifyTargetUser(String(reassignToUserId), "targets_refresh", {});
        notifyTargetUser(String(targetLean.salesPerson._id), "targets_refresh", {});
        try {
          const admins = await findAdmins(User, Role);
          admins.forEach((a) => { notifyTargetUser(String(a._id), "targets_refresh", {}); notifyTargetUser(String(a._id), "target_due_today", {}); });
        } catch (_) { /* non-critical */ }
      }

      res.status(200).json({ message: isSamePerson ? "Deadline extended" : "Items reassigned successfully" });
    } catch (err) {
      console.error("Error reassigning target items:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: delete a single reason note
  deleteReasonNote: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") return res.status(403).json({ message: "Access denied" });
      const { Target } = getModels(req);
      const target = await Target.findById(req.params.id);
      if (!target) return res.status(404).json({ message: "Target not found" });
      const idx = parseInt(req.params.noteIdx, 10);
      if (isNaN(idx) || idx < 0 || idx >= target.reasonNotes.length)
        return res.status(404).json({ message: "Note not found" });
      target.reasonNotes.splice(idx, 1);
      await target.save();
      res.status(200).json({ message: "Note deleted" });
    } catch (err) {
      console.error("Error deleting reason note:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: bulk delete reason notes
  bulkDeleteReasonNotes: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") return res.status(403).json({ message: "Access denied" });
      const { Target } = getModels(req);
      const { items } = req.body; // [{targetId, noteIdx}]
      if (!Array.isArray(items) || items.length === 0)
        return res.status(400).json({ message: "items array is required" });

      // Group by targetId and sort indices descending (to avoid shifting)
      const byTarget = {};
      for (const { targetId, noteIdx } of items) {
        if (!byTarget[targetId]) byTarget[targetId] = [];
        byTarget[targetId].push(parseInt(noteIdx, 10));
      }
      for (const [targetId, indices] of Object.entries(byTarget)) {
        const target = await Target.findById(targetId);
        if (!target) continue;
        const sorted = [...new Set(indices)].sort((a, b) => b - a);
        for (const idx of sorted) {
          if (idx >= 0 && idx < target.reasonNotes.length) target.reasonNotes.splice(idx, 1);
        }
        await target.save();
      }
      res.status(200).json({ message: "Notes deleted" });
    } catch (err) {
      console.error("Error bulk deleting reason notes:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin-only: leads Admin personally converted + deals Admin personally
  // closed Won — the "Admin Completed" activity feed in Target Management.
  // Strictly Target-scoped: only leads/deals that are actually linked to a
  // Target (linkedLeads/linkedDeals) show up here. A lead/deal linked to
  // BOTH a Task and a Target legitimately shows in both feeds — that's real
  // dual context, not a bug. Mirrors task.controller.js's getAdminActivity,
  // deliberately kept as a separate, independent endpoint/dismiss-flag so the
  // two features never share state.
  getAdminActivity: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") return res.status(403).json({ message: "Access denied: Admins only" });
      const models = getModels(req);
      const { Lead, Deal } = models;

      const [convertedLeads, wonDeals, linkage] = await Promise.all([
        Lead.find({ status: "Converted", convertedBy: { $ne: null }, targetAdminActivityDismissed: { $ne: true } })
          .populate({ path: "convertedBy", select: "firstName lastName role", populate: { path: "role", select: "name" } })
          .populate("assignTo", "firstName lastName")
          .select("leadName companyName convertedBy assignTo updatedAt")
          .sort({ updatedAt: -1 })
          .lean(),
        Deal.find({ stage: "Closed Won", wonBy: { $ne: null }, targetAdminActivityDismissed: { $ne: true } })
          .populate({ path: "wonBy", select: "firstName lastName role", populate: { path: "role", select: "name" } })
          .populate("assignedTo", "firstName lastName")
          .select("dealName dealTitle companyName value currency wonBy wonAt assignedTo")
          .sort({ wonAt: -1 })
          .lean(),
        getBulkLinkage(models),
      ]);

      const { targetLeadIds, targetDealIds } = linkage;

      const leadsConvertedByAdmin = convertedLeads
        .filter((l) => l.convertedBy?.role?.name === "Admin")
        .filter((l) => targetLeadIds.has(String(l._id)));
      const dealsWonByAdmin = wonDeals
        .filter((d) => d.wonBy?.role?.name === "Admin")
        .filter((d) => targetDealIds.has(String(d._id)));

      res.status(200).json({
        leadsConvertedByAdmin,
        dealsWonByAdmin,
        counts: { leads: leadsConvertedByAdmin.length, deals: dealsWonByAdmin.length },
      });
    } catch (err) {
      console.error("Error fetching target admin activity:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin-only: dismiss (hide) a single lead/deal row from Target
  // Management's "Admin Completed" feed — declutter only, never touches the
  // underlying record, and never affects Task Management's own Admin
  // Completed feed (separate taskAdminActivityDismissed flag).
  dismissAdminActivity: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") return res.status(403).json({ message: "Access denied: Admins only" });
      const { itemType, itemId } = req.body;
      if (!["lead", "deal"].includes(itemType) || !itemId) {
        return res.status(400).json({ message: "itemType (lead|deal) and itemId are required" });
      }
      const { Lead, Deal } = getModels(req);
      const Model = itemType === "lead" ? Lead : Deal;
      await Model.findByIdAndUpdate(itemId, { targetAdminActivityDismissed: true });
      res.status(200).json({ message: "Removed from Admin Completed" });
    } catch (err) {
      console.error("Error dismissing target admin activity item:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Manual target reporting for calls
  addCallReport: async (req, res) => {
    try {
      const { Target } = getModels(req);
      const { id } = req.params;
      const { companyName, callSummary, companyUrl } = req.body;
      const recordingUrl = req.file ? req.file.path : null;

      if (!companyName || !callSummary) {
        return res.status(400).json({ message: "Company name and call summary are required" });
      }

      const target = await Target.findById(id);
      if (!target) return res.status(404).json({ message: "Target not found" });

      // Verify ownership or admin
      if (String(target.salesPerson) !== String(req.user._id) && req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied" });
      }

      target.reportedCalls.push({
        companyName,
        callSummary,
        companyUrl,
        recordingUrl,
        addedBy: req.user._id,
      });

      await target.save();
      res.status(200).json({ message: "Call report added successfully", target });
    } catch (err) {
      console.error("Error adding call report:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Manual target reporting for meetings
  addMeetingReport: async (req, res) => {
    try {
      const { Target } = getModels(req);
      const { id } = req.params;
      const { companyName, meetingSummary, companyUrl } = req.body;
      const screenshotUrl = req.file ? req.file.path : null;

      if (!companyName || !meetingSummary) {
        return res.status(400).json({ message: "Company name and meeting summary are required" });
      }

      const target = await Target.findById(id);
      if (!target) return res.status(404).json({ message: "Target not found" });

      if (String(target.salesPerson) !== String(req.user._id) && req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied" });
      }

      target.reportedMeetings.push({
        companyName,
        meetingSummary,
        companyUrl,
        screenshotUrl,
        addedBy: req.user._id,
      });

      await target.save();
      res.status(200).json({ message: "Meeting report added successfully", target });
    } catch (err) {
      console.error("Error adding meeting report:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },
};



