import { v4 as uuidv4 } from "uuid";
import { getTenantModels } from "../models/tenant/index.js";
import CallLogLegacy from "../models/callLog.model.js";

const getCallLog = (req) => req.tenantDB ? getTenantModels(req.tenantDB).CallLog : CallLogLegacy;

export default {
  createCallLog: async (req, res) => {
    try {
      const CallLog = getCallLog(req);
      const sessionId = uuidv4();
      const callLog = new CallLog({
        ...req.body, userId: req.user._id, sessionId,
        startTime: new Date(), callStatus: "initiated",
        userAgent: req.headers["user-agent"], ipAddress: req.ip,
      });
      await callLog.save();
      await callLog.populate("leadId", "leadName companyName phoneNumber");
      res.status(201).json({ success: true, data: callLog, sessionId });
    } catch (error) {
      console.error("Create call log error:", error);
      res.status(400).json({ success: false, message: error.message });
    }
  },

  trackCallStart: async (req, res) => {
    try {
      const CallLog = getCallLog(req);
      const callLog = await CallLog.findOne({ sessionId: req.params.sessionId });
      if (!callLog) return res.status(404).json({ success: false, message: "Call session not found" });
      callLog.startTime = new Date(); callLog.callStatus = "in-progress"; callLog.trackingMethod = "visibility";
      await callLog.save();
      res.json({ success: true, message: "Call start tracked", startTime: callLog.startTime });
    } catch (error) {
      console.error("Track call start error:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  trackCallEnd: async (req, res) => {
    try {
      const CallLog = getCallLog(req);
      const callLog = await CallLog.findOne({ sessionId: req.params.sessionId });
      if (!callLog) return res.status(404).json({ success: false, message: "Call session not found" });
      callLog.endTime = new Date(); callLog.callStatus = "completed";
      await callLog.save();
      res.json({ success: true, message: "Call end tracked", duration: callLog.duration, formattedDuration: callLog.formattedDuration });
    } catch (error) {
      console.error("Track call end error:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  trackHeartbeat: async (req, res) => {
    try {
      const CallLog = getCallLog(req);
      const callLog = await CallLog.findOne({ sessionId: req.params.sessionId });
      if (!callLog) return res.status(404).json({ success: false, message: "Call session not found" });
      callLog.metadata.set("lastHeartbeat", new Date());
      await callLog.save();
      res.json({ success: true, message: "Heartbeat received" });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  },

  getCallLogs: async (req, res) => {
    try {
      const CallLog = getCallLog(req);
      const { leadId, days = 30, page = 1, limit = 20 } = req.query;
      const query = { userId: req.user._id };
      if (leadId) query.leadId = leadId;
      if (days) { const d = new Date(); d.setDate(d.getDate() - parseInt(days)); query.createdAt = { $gte: d }; }
      const skip = (parseInt(page) - 1) * parseInt(limit);
      const [logs, total] = await Promise.all([
        CallLog.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).populate("leadId", "leadName companyName phoneNumber"),
        CallLog.countDocuments(query),
      ]);
      res.json({
        success: true, data: logs,
        stats: { total, completed: logs.filter(l => l.callStatus === "completed").length, missed: logs.filter(l => l.callStatus === "missed").length, avgDuration: logs.reduce((a, l) => a + (l.duration || 0), 0) / (logs.length || 1) },
        pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) },
      });
    } catch (error) {
      console.error("Get call logs error:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  getCallLogById: async (req, res) => {
    try {
      const CallLog = getCallLog(req);
      const callLog = await CallLog.findOne({ _id: req.params.id, userId: req.user._id }).populate("leadId", "leadName companyName phoneNumber");
      if (!callLog) return res.status(404).json({ success: false, message: "Call log not found" });
      res.json({ success: true, data: callLog });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  },

  updateCallLog: async (req, res) => {
    try {
      const CallLog = getCallLog(req);
      const callLog = await CallLog.findOneAndUpdate({ _id: req.params.id, userId: req.user._id }, req.body, { new: true }).populate("leadId", "leadName companyName");
      if (!callLog) return res.status(404).json({ success: false, message: "Call log not found" });
      res.json({ success: true, data: callLog });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  },

  getCallStats: async (req, res) => {
    try {
      const CallLog = getCallLog(req);
      const { days = 30 } = req.query;
      const startDate = new Date(); startDate.setDate(startDate.getDate() - parseInt(days));
      const stats = await CallLog.aggregate([
        { $match: { userId: req.user._id, createdAt: { $gte: startDate } } },
        { $facet: {
          byStatus: [{ $group: { _id: "$callStatus", count: { $sum: 1 } } }],
          byDay: [{ $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, count: { $sum: 1 }, avgDuration: { $avg: "$duration" } } }, { $sort: { _id: -1 } }, { $limit: 7 }],
          totals: [{ $group: { _id: null, totalCalls: { $sum: 1 }, totalDuration: { $sum: "$duration" }, avgDuration: { $avg: "$duration" }, completedCalls: { $sum: { $cond: [{ $eq: ["$callStatus","completed"] }, 1, 0] } }, missedCalls: { $sum: { $cond: [{ $eq: ["$callStatus","missed"] }, 1, 0] } } } }],
        }},
      ]);
      res.json({ success: true, data: stats[0] });
    } catch (error) {
      console.error("Get call stats error:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  },
};
