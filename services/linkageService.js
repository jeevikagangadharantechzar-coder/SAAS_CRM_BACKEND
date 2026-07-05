// Neither Lead nor Deal carries a back-reference to the Task or Target it's
// part of — linkage can only be derived by querying the owning Task/Target
// documents directly. This is the single source of truth both
// taskNotificationService.js and targetNotificationService.js (and their
// controllers' "Admin Completed" feeds) use to decide whether a given
// lead/deal event belongs to Task Management, Target Management, both, or
// neither — so the two features never bleed into each other.
export async function getLinkage(models, { leadId, dealId }) {
  const { Task, Target } = models;
  const taskOr = [];
  const targetOr = [];
  if (leadId) { taskOr.push({ leadRef: leadId }); targetOr.push({ linkedLeads: leadId }); }
  if (dealId) { taskOr.push({ dealRef: dealId }); targetOr.push({ linkedDeals: dealId }); }

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
  const { Task, Target } = models;
  const [taskLeadIds, taskDealIds, targetLeadIds, targetDealIds] = await Promise.all([
    Task ? Task.distinct("leadRef", { leadRef: { $ne: null }, archived: { $ne: true } }) : [],
    Task ? Task.distinct("dealRef", { dealRef: { $ne: null }, archived: { $ne: true } }) : [],
    Target ? Target.distinct("linkedLeads") : [],
    Target ? Target.distinct("linkedDeals") : [],
  ]);
  return {
    taskLeadIds: new Set(taskLeadIds.map(String)),
    taskDealIds: new Set(taskDealIds.map(String)),
    targetLeadIds: new Set(targetLeadIds.map(String)),
    targetDealIds: new Set(targetDealIds.map(String)),
  };
}
