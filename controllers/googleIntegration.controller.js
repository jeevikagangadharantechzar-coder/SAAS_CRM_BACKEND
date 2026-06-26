import { getTenantModels } from "../models/tenant/index.js";

const getModels = (req) => getTenantModels(req.tenantDB);

export default {
  getStatus: async (req, res) => {
    try {
      const { GoogleIntegration } = getModels(req);
      const integration = await GoogleIntegration.findOne({}, "-credentials");
      res.json({
        success: true,
        connected: !!integration,
        connectedAt: integration?.updatedAt || null,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  save: async (req, res) => {
    try {
      let { credentials } = req.body;
      if (!credentials) {
        return res.status(400).json({ success: false, message: "credentials are required" });
      }

      if (typeof credentials === "string") {
        try {
          credentials = JSON.parse(credentials);
        } catch {
          return res.status(400).json({ success: false, message: "Invalid JSON format" });
        }
      }

      if (credentials.type !== "service_account") {
        return res.status(400).json({ success: false, message: "Must be a service_account JSON" });
      }

      const { GoogleIntegration } = getModels(req);
      await GoogleIntegration.findOneAndUpdate(
        {},
        { credentials, connectedBy: req.user._id },
        { upsert: true, new: true }
      );

      res.json({ success: true, message: "Google integration saved" });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  remove: async (req, res) => {
    try {
      const { GoogleIntegration } = getModels(req);
      await GoogleIntegration.deleteMany({});
      res.json({ success: true, message: "Google integration removed" });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
};
