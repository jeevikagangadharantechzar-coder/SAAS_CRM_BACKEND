/**
 * Round-robin assignment: picks the next Sales-role user to assign a lead to.
 * Used by leads.controller.js (manual create) and meta.controller.js (Facebook/Instagram sync + webhook).
 */
export const pickNextSalesUser = async (User, Lead) => {
  const users = await User
    .find({})
    .populate("role", "name")
    .select("_id firstName lastName role status createdAt")
    .sort({ createdAt: 1, _id: 1 })
    .lean();

  const salesUsers = users.filter((u) => {
    const roleName =
      typeof u.role === "string"
        ? u.role
        : u.role?.name || u.role?.roleName || "";
    return String(roleName).toLowerCase() === "sales";
  });

  // Inactive users are skipped. A missing status counts as Active (older records).
  const isUserActive = (u) => !u.status || String(u.status).trim().toLowerCase() !== "inactive";
  if (!salesUsers.some(isUserActive)) return null;

  const lastLead = await Lead.findOne({ assignTo: { $ne: null } })
    .sort({ createdAt: -1, _id: -1 })
    .select("assignTo")
    .lean();

  // Find the last assignee in the full sales list (inactive users included),
  // so the rotation keeps its place when that user has since been deactivated.
  const lastIdx = lastLead?.assignTo
    ? salesUsers.findIndex(
        (u) => u._id.toString() === lastLead.assignTo.toString()
      )
    : -1;

  for (let step = 1; step <= salesUsers.length; step++) {
    const candidate = salesUsers[(lastIdx + step) % salesUsers.length];
    if (isUserActive(candidate)) return candidate._id;
  }
  return null;
};
