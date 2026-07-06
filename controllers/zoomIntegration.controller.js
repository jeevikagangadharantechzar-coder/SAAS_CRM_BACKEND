import { getTenantModels } from "../models/tenant/index.js";
import { encrypt } from "../utils/crypto.js";

const getModels = (req) => getTenantModels(req.tenantDB);

export default {
  getStatus: async (req, res) => {
    try {
      const { ZoomIntegration } = getModels(req);
      const integration = await ZoomIntegration.findOne({}, "-clientSecret");
      res.json({
        success: true,
        connected: !!integration,
        clientId: integration?.clientId || null,
        accountId: integration?.accountId || null,
        hostUserId: integration?.hostUserId || null,
        connectedAt: integration?.updatedAt || null,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  save: async (req, res) => {
    try {
      const { clientId, clientSecret, accountId, hostUserId } = req.body;
      if (!clientId || !clientSecret || !accountId || !hostUserId) {
        return res.status(400).json({
          success: false,
          message: "clientId, clientSecret, accountId, and hostUserId are all required",
        });
      }

      const { ZoomIntegration } = getModels(req);
      await ZoomIntegration.findOneAndUpdate(
        {},
        {
          clientId: clientId.trim(),
          clientSecret: encrypt(clientSecret.trim()),
          accountId: accountId.trim(),
          hostUserId: hostUserId.trim(),
          connectedBy: req.user._id,
        },
        { upsert: true, new: true }
      );

      res.json({ success: true, message: "Zoom integration saved" });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  remove: async (req, res) => {
    try {
      const { ZoomIntegration } = getModels(req);
      await ZoomIntegration.deleteMany({});
      res.json({ success: true, message: "Zoom integration removed" });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
};
