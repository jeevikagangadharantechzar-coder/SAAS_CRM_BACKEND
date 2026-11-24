import { getTenantModels } from "../models/tenant/index.js";
import LeadTableConfigLegacy from "../models/leadTableConfig.model.js";
import { normalizeLeadTableColumns, validateLeadTableColumns } from "../utils/leadTableColumns.js";
import { notifyTenant } from "../realtime/socket.js";

const getModel = (req) => (req.tenantDB ? getTenantModels(req.tenantDB).LeadTableConfig : LeadTableConfigLegacy);

export default {
  // GET /leads/table-columns — every logged-in user reads the same layout.
  getLeadTableColumns: async (req, res) => {
    try {
      const config = await getModel(req).findOne().select("columns").lean();
      res.status(200).json({ success: true, columns: normalizeLeadTableColumns(config?.columns) });
    } catch (error) {
      console.error("Get Lead Table Columns Error:", error);
      res.status(500).json({ message: "Server Error" });
    }
  },

  // PUT /leads/table-columns — Admin only.
  // Body: { columns: [{ key, visible }, ...] } in display order, or { reset: true }.
  updateLeadTableColumns: async (req, res) => {
    try {
      const { columns, reset } = req.body || {};
      if (!reset) {
        const error = validateLeadTableColumns(columns);
        if (error) return res.status(400).json({ message: error });
      }
      const normalized = normalizeLeadTableColumns(reset ? [] : columns);

      await getModel(req).findOneAndUpdate(
        {},
        { columns: reset ? [] : normalized, updatedBy: req.user?._id || null },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      // Every user of this tenant sees the new layout straight away.
      notifyTenant(req.tenant?.dbName, "lead_columns_updated", { columns: normalized });

      res.status(200).json({ success: true, message: "Lead table columns updated", columns: normalized });
    } catch (error) {
      console.error("Update Lead Table Columns Error:", error);
      res.status(500).json({ message: "Server Error" });
    }
  },
};
