import { getTenantModels } from "../models/tenant/index.js";
import * as zoomService from "../services/zoom.service.js";

// Zoom is tenant-specific — each tenant connects their own account via
// Settings (see zoomIntegration.controller.js). This just tells the frontend
// whether the currently logged-in tenant has valid Zoom credentials saved,
// so it knows whether to offer the Zoom option when creating a meeting.
const zoomAuthController = {
  getAuthStatus: async (req, res) => {
    try {
      const { ZoomIntegration } = getTenantModels(req.tenantDB);
      const integration = await ZoomIntegration.findOne({});
      const connected = zoomService.isZoomConfigured(integration);
      res.json({ success: true, connected });
    } catch (err) {
      console.error("Zoom getAuthStatus error:", err);
      res.status(500).json({ success: false, connected: false });
    }
  },
};

export default zoomAuthController;
