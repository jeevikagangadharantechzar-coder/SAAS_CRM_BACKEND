import Tenant from "../models/master/Tenant.js";
import { getTenantDB } from "../config/tenantDB.js";
import { getTenantModels } from "../models/tenant/index.js";

// Reads activity logs from a single tenant's own database — there is no
// cross-tenant store, so this always resolves the target tenant's DB first.
export const getTenantActivityLogs = async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) return res.status(404).json({ success: false, error: "Tenant not found" });

    const {
      page = 1,
      limit = 25,
      module,
      method,
      status,
      search,
      startDate,
      endDate,
      export: isExport,
    } = req.query;

    const tenantDB = await getTenantDB(tenant.dbName);
    const { ActivityLog } = getTenantModels(tenantDB);

    const filter = {};
    if (module) filter.module = module;
    if (method) filter.method = method;
    if (status) filter.status = status;

    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }

    if (search) {
      const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ userName: re }, { action: re }, { endpoint: re }, { errorMessage: re }];
    }

    // Export mode: same filters, but unpaginated (capped by
    // ACTIVITY_LOG_EXPORT_MAX_ROWS so a huge log history can't exhaust memory).
    const exportMaxRows = Math.max(1, Number(process.env.ACTIVITY_LOG_EXPORT_MAX_ROWS) || 5000);
    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = isExport
      ? exportMaxRows
      : Math.min(200, Math.max(1, Number(limit) || 25));
    const skip = isExport ? 0 : (pageNum - 1) * limitNum;

    const [logs, total, modules] = await Promise.all([
      ActivityLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      ActivityLog.countDocuments(filter),
      ActivityLog.distinct("module"),
    ]);

    res.json({
      success: true,
      logs,
      total,
      page: isExport ? 1 : pageNum,
      pages: isExport ? 1 : Math.max(1, Math.ceil(total / limitNum)),
      modules: modules.sort(),
    });
  } catch (err) {
    console.error("Get tenant activity logs error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};
