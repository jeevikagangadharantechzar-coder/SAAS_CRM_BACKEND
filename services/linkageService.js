// Neither Lead nor Deal carries a back-reference to the Task or Target it's
// part of — linkage can only be derived by querying the owning Task/Target
// documents directly. This is the single source of truth both
// taskNotificationService.js and targetNotificationService.js (and their
// controllers' "Admin Completed" feeds) use to decide whether a given
// lead/deal event belongs to Task Management, Target Management, both, or
// neither — so the two features never bleed into each other.
export async function getLinkage(models, { leadId, dealId }) {
  const { Task, Target, Deal } = models;
  const taskOr = [];
  const targetOr = [];
  if (leadId) { taskOr.push({ leadRef: leadId }); targetOr.push({ linkedLeads: leadId }); }
  if (dealId) {
    taskOr.push({ dealRef: dealId });
    targetOr.push({ linkedDeals: dealId });
    // A deal born from converting a linked lead never gets its own _id added
    // to linkedDeals/dealRef — it's only reachable via its parent lead. Without
    // this, a Target-linked lead's resulting Closed-Won deal reads as
    // "linked nowhere" and falls through to the wrong Task/Target routing.
    if (Deal) {
      const dealDoc = await Deal.findById(dealId).select("leadId").lean();
      if (dealDoc?.leadId) {
        taskOr.push({ leadRef: dealDoc.leadId });
        targetOr.push({ linkedLeads: dealDoc.leadId });
      }
    }
  }

  const [isTaskLinked, isTargetLinked] = await Promise.all([
    taskOr.length && Task ? Task.exists({ $or: taskOr, archived: { $ne: true } }) : false,
    targetOr.length && Target ? Target.exists({ $or: targetOr }) : false,
  ]);
  return { isTaskLinked: !!isTaskLinked, isTargetLinked: !!isTargetLinked };
}

// Same linkage boundary as getLinkage above, but resolved once for an entire
// list of leads/deals instead of per-item — used by the "Admin Completed"
// feeds (task.controller.js's and target.controller.js's getAdminActivity),
// which need to classify a whole batch of admin-converted leads/won deals at
// once without N+1 queries.
export async function getBulkLinkage(models) {
  const { Task, Target, Deal } = models;
  const [taskLeadIds, taskDealIds, targetLeadIds, targetDealIds] = await Promise.all([
    Task ? Task.distinct("leadRef", { leadRef: { $ne: null }, archived: { $ne: true } }) : [],
    Task ? Task.distinct("dealRef", { dealRef: { $ne: null }, archived: { $ne: true } }) : [],
    Target ? Target.distinct("linkedLeads") : [],
    Target ? Target.distinct("linkedDeals") : [],
  ]);

  const taskLeadIdSet = new Set(taskLeadIds.map(String));
  const taskDealIdSet = new Set(taskDealIds.map(String));
  const targetLeadIdSet = new Set(targetLeadIds.map(String));
  const targetDealIdSet = new Set(targetDealIds.map(String));

  // Same gap as getLinkage above: a deal created by converting a linked lead
  // never gets its own _id added to linkedDeals/dealRef, so it's only
  // reachable via its parent lead. Look up every deal born from any
  // task/target-linked lead and fold its _id into the matching deal-id set —
  // otherwise that deal reads as "linked nowhere" (e.g. vanishing from Target
  // Management's "Deals Won by Admin" list, or leaking into Task Management's
  // Admin Completed feed instead via its own "unlinked falls back to task" rule).
  if (Deal) {
    const allLinkedLeadIds = [...new Set([...taskLeadIdSet, ...targetLeadIdSet])];
    if (allLinkedLeadIds.length) {
      const derivedDeals = await Deal.find({ leadId: { $in: allLinkedLeadIds } }).select("leadId").lean();
      for (const d of derivedDeals) {
        const leadIdStr = String(d.leadId);
        const dealIdStr = String(d._id);
        if (taskLeadIdSet.has(leadIdStr)) taskDealIdSet.add(dealIdStr);
        if (targetLeadIdSet.has(leadIdStr)) targetDealIdSet.add(dealIdStr);
      }
    }
  }

  return {
    taskLeadIds: taskLeadIdSet,
    taskDealIds: taskDealIdSet,
    targetLeadIds: targetLeadIdSet,
    targetDealIds: targetDealIdSet,
  };
}
