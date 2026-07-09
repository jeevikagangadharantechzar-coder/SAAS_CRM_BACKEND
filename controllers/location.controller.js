import { getTenantModels } from "../models/tenant/index.js";
import { getAdminUserIds } from "../services/notificationService.js";
import { notifyAdmins } from "../realtime/socket.js";

export default {
  // Sales — reports the device's current position while the CRM tab is open.
  updateLocation: async (req, res) => {
    try {
      if (!req.tenantDB) return res.status(404).json({ success: false, message: "Workspace not found" });
      const { latitude, longitude, accuracy } = req.body;
      if (typeof latitude !== "number" || typeof longitude !== "number") {
        return res.status(400).json({ success: false, message: "latitude and longitude are required" });
      }

      const { UserLocation } = getTenantModels(req.tenantDB);
      const updatedAt = new Date();

      await UserLocation.findOneAndUpdate(
        { userId: req.user._id },
        { latitude, longitude, accuracy: accuracy ?? null, updatedAt },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      const adminIds = await getAdminUserIds(req.tenantDB);
      notifyAdmins(adminIds, "location_update", {
        userId: String(req.user._id),
        name: `${req.user.firstName} ${req.user.lastName}`,
        latitude, longitude, accuracy: accuracy ?? null,
        updatedAt,
      });

      res.status(200).json({ success: true });
    } catch (error) {
      console.error("Update location error:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  // Admin — initial snapshot of every Sales user's last known position (live
  // updates arrive over the socket via the "location_update" event above).
  getTeamLocations: async (req, res) => {
    try {
      const { UserLocation, User } = getTenantModels(req.tenantDB);
      const users = await User.find().populate("role", "name").select("firstName lastName email role");
      const salesUserIds = users
        .filter((u) => u.role?.name?.toLowerCase() === "sales")
        .map((u) => u._id);

      const locations = await UserLocation.find({ userId: { $in: salesUserIds } }).lean();
      const locationMap = new Map(locations.map((l) => [String(l.userId), l]));

      const team = users
        .filter((u) => u.role?.name?.toLowerCase() === "sales")
        .map((u) => {
          const loc = locationMap.get(String(u._id));
          return {
            userId: u._id,
            name: `${u.firstName} ${u.lastName}`,
            email: u.email,
            latitude: loc?.latitude ?? null,
            longitude: loc?.longitude ?? null,
            accuracy: loc?.accuracy ?? null,
            updatedAt: loc?.updatedAt ?? null,
          };
        });

      res.status(200).json({ success: true, team });
    } catch (error) {
      console.error("Get team locations error:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  },
};
