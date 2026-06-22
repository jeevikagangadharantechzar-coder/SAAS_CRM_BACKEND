import mongoose from "mongoose";
import { getTenantModels } from "../models/tenant/index.js";
import UserLegacy     from "../models/user.model.js";
import LeadLegacy     from "../models/leads.model.js";
import ActivityLegacy from "../models/activity.models.js";
import InvoiceLegacy  from "../models/invoice.model.js";

const getModels = (req) =>
  req.tenantDB
    ? getTenantModels(req.tenantDB)
    : { User: UserLegacy, Lead: LeadLegacy, Activity: ActivityLegacy, Invoice: InvoiceLegacy };

const getSalesPerformance = async (req, res) => {
  try {
    const { userId, startDate, endDate } = req.query;
    if (!userId || !mongoose.Types.ObjectId.isValid(userId))
      return res.status(400).json({ message: "Invalid or missing userId" });

    const { User, Lead, Activity, Invoice } = getModels(req);
    const user = await User.findById(userId).select("firstName lastName email role loginHistory");
    if (!user) return res.status(404).json({ message: "User not found" });

    let loginData = [];
    if (user.loginHistory && Array.isArray(user.loginHistory)) {
      loginData = user.loginHistory.filter(item => {
        if (!item.login) return false;
        const d = new Date(item.login);
        if (startDate && endDate) {
          const s = new Date(startDate); s.setHours(0,0,0,0);
          const e = new Date(endDate);   e.setHours(23,59,59,999);
          return d >= s && d <= e;
        }
        if (startDate) {
          const s = new Date(startDate); s.setHours(0,0,0,0);
          const e = new Date(startDate); e.setHours(23,59,59,999);
          return d >= s && d <= e;
        }
        return true;
      });
    }

    const dateFilter = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {};
      if (startDate) dateFilter.createdAt.$gte = new Date(startDate);
      if (endDate)   dateFilter.createdAt.$lte = new Date(endDate);
    }

    const leads      = await Lead.find({ assignTo: user._id, ...dateFilter }).lean();
    const activities = await Activity.find({ assignedTo: user._id, ...dateFilter }).lean();
    let invoices = [];
    try { invoices = await Invoice.find({ assignedTo: user._id, ...dateFilter }).lean(); }
    catch (e) { console.warn("Invoice model may not be set up – ignoring:", e.message); }

    res.status(200).json({
      salesperson: { _id: user._id, name: `${user.firstName} ${user.lastName}`, email: user.email },
      loginHistory: loginData,
      metrics: { totalLeadsAssigned: leads.length, totalActivitiesAssigned: activities.length, totalInvoicesAssigned: invoices.length },
      leads, activities, invoices,
    });
  } catch (err) {
    console.error("Error in getSalesPerformance:", err);
    res.status(500).json({ message: err.message });
  }
};

export default { getSalesPerformance };
