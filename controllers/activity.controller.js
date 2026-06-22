import mongoose from "mongoose";
import { getTenantModels } from "../models/tenant/index.js";
import ActivityLegacy from "../models/activity.models.js";
import DealLegacy     from "../models/deals.model.js";

const getModels = (req) =>
  req.tenantDB ? getTenantModels(req.tenantDB) : { Activity: ActivityLegacy, Deal: DealLegacy };

export default {
  getActivities: async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Unauthorized: No user found" });
      const { Activity } = getModels(req);
      let query;
      if (req.user.role?.name === "Admin")  query = Activity.find();
      else if (req.user.role?.name === "Sales") query = Activity.find({ assignedTo: req.user._id });
      else return res.status(403).json({ error: "Access denied" });

      const activities = await query
        .populate("deal", "title")
        .populate("assignedTo", "firstName lastName email")
        .sort({ createdAt: -1 });
      res.status(200).json(activities);
    } catch (error) {
      console.error("Error fetching activities:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  getActivityById: async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid activity ID" });
      const { Activity } = getModels(req);
      const activity = await Activity.findById(id)
        .populate("deal", "title")
        .populate("assignedTo", "name email");
      if (!activity) return res.status(404).json({ message: "Activity not found" });
      res.status(200).json(activity);
    } catch (error) {
      console.error("Error fetching activity:", error);
      res.status(500).json({ message: "Error fetching activity" });
    }
  },

  addActivity: async (req, res) => {
    try {
      const { Activity } = getModels(req);
      const { title, description, startDate, endDate, startTime, endTime, activityCategory, deal, assignedTo, reminder } = req.body;
      const newActivity = new Activity({
        title, description,
        startDate: new Date(startDate), endDate: new Date(endDate),
        startTime, endTime, activityCategory, deal, assignedTo,
        reminder: reminder ? new Date(reminder) : undefined,
      });
      let saved = await newActivity.save();
      saved = await saved.populate([
        { path: "deal", select: "title" },
        { path: "assignedTo", select: "firstName lastName email" },
      ]);
      res.status(201).json({ message: "Activity added successfully", data: saved });
    } catch (error) {
      console.error("Error adding activity:", error);
      res.status(500).json({ message: "Error adding activity" });
    }
  },

  updateActivity: async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid activity ID" });
      const { Activity } = getModels(req);
      const { startDate, endDate, deal, assignedTo } = req.body;
      if (startDate && endDate && new Date(endDate) < new Date(startDate))
        return res.status(400).json({ message: "End date must be after start date" });
      if (deal && !mongoose.Types.ObjectId.isValid(deal)) return res.status(400).json({ message: "Invalid deal ID" });
      if (assignedTo && !mongoose.Types.ObjectId.isValid(assignedTo)) return res.status(400).json({ message: "Invalid assignedTo ID" });

      const updated = await Activity.findByIdAndUpdate(id, req.body, { new: true, runValidators: true })
        .populate("deal", "title")
        .populate("assignedTo", "firstName lastName email");
      if (!updated) return res.status(404).json({ message: "Activity not found" });
      res.status(200).json({ message: "Activity updated successfully", data: updated });
    } catch (error) {
      console.error("Error updating activity:", error);
      res.status(500).json({ message: "Error updating activity" });
    }
  },

  deleteActivity: async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid activity ID" });
      const { Activity } = getModels(req);
      const deleted = await Activity.findByIdAndDelete(id);
      if (!deleted) return res.status(404).json({ message: "Activity not found" });
      res.status(200).json({ message: "Activity deleted successfully" });
    } catch (error) {
      console.error("Error deleting activity:", error);
      res.status(500).json({ message: "Error deleting activity" });
    }
  },
};
