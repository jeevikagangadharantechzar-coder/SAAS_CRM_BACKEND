import { getTenantModels } from "../models/tenant/index.js";
import LeadLegacy from "../models/leads.model.js";

const getModels = (req) =>
  req.tenantDB
    ? getTenantModels(req.tenantDB)
    : { Lead: LeadLegacy };

export default {
  getLeadLossAnalytics: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin" && req.user.role?.name !== "Sales") {
        return res.status(403).json({ message: "Access denied" });
      }

      const { Lead } = getModels(req);
      const { startDate, endDate, year, month } = req.query;

      const query = {
        status: "Cold",
        rejectionReason: { $exists: true, $ne: "" },
        trash: { $ne: true }
      };

      // Filter by Date Range
      if (startDate || endDate) {
        query.updatedAt = {};
        if (startDate) query.updatedAt.$gte = new Date(startDate);
        if (endDate) query.updatedAt.$lte = new Date(`${endDate}T23:59:59.999Z`);
      } 
      // Filter by Year / Month
      else if (year) {
        const start = new Date(year, month ? parseInt(month) - 1 : 0, 1);
        const end = new Date(year, month ? parseInt(month) : 12, 0, 23, 59, 59, 999);
        query.updatedAt = { $gte: start, $lte: end };
      }

      // If user is sales, only show their leads
      if (req.user.role?.name !== "Admin") {
        query.assignTo = req.user._id;
      }

      const leads = await Lead.find(query)
        .populate("assignTo", "firstName lastName email")
        .sort({ updatedAt: -1 })
        .lean();

      // Query for total leads to calculate loss rate
      const totalQuery = { trash: { $ne: true } };
      if (startDate || endDate) {
        totalQuery.createdAt = {};
        if (startDate) totalQuery.createdAt.$gte = new Date(startDate);
        if (endDate) totalQuery.createdAt.$lte = new Date(`${endDate}T23:59:59.999Z`);
      } else if (year) {
        const start = new Date(year, month ? parseInt(month) - 1 : 0, 1);
        const end = new Date(year, month ? parseInt(month) : 12, 0, 23, 59, 59, 999);
        totalQuery.createdAt = { $gte: start, $lte: end };
      }
      if (req.user.role?.name !== "Admin") {
        totalQuery.assignTo = req.user._id;
      }
      const totalLeads = await Lead.countDocuments(totalQuery);

      // Query for total Junk leads
      const junkQuery = { status: "Junk", trash: { $ne: true } };
      if (startDate || endDate) {
        junkQuery.updatedAt = {};
        if (startDate) junkQuery.updatedAt.$gte = new Date(startDate);
        if (endDate) junkQuery.updatedAt.$lte = new Date(`${endDate}T23:59:59.999Z`);
      } else if (year) {
        const start = new Date(year, month ? parseInt(month) - 1 : 0, 1);
        const end = new Date(year, month ? parseInt(month) : 12, 0, 23, 59, 59, 999);
        junkQuery.updatedAt = { $gte: start, $lte: end };
      }
      if (req.user.role?.name !== "Admin") {
        junkQuery.assignTo = req.user._id;
      }
      const totalJunk = await Lead.countDocuments(junkQuery);

      // Calculate pre-defined KPIs
      const totalLost = leads.length;
      const lossRate = totalLeads > 0 ? ((totalLost / totalLeads) * 100).toFixed(1) : 0;
      
      const stageDistribution = {
        Cold: 0,
        Warm: 0,
        Hot: 0,
        Unknown: 0
      };

      let totalFollowUps = 0;
      let totalAge = 0;

      const reasonsMap = {};

      leads.forEach(lead => {
        // Loss Stage
        const stage = lead.lossStage || "Unknown";
        if (stageDistribution[stage] !== undefined) {
          stageDistribution[stage]++;
        } else {
           stageDistribution.Unknown++;
        }

        // Follow ups
        totalFollowUps += lead.followUpCountAtLoss || 0;
        
        // Age
        totalAge += lead.leadAgeAtLossDays || 0;

        // Highest Reason
        const reason = lead.rejectionReason || lead.junkReason || "Unspecified Reason";
        reasonsMap[reason] = (reasonsMap[reason] || 0) + 1;
      });

      const avgFollowUps = totalLost > 0 ? (totalFollowUps / totalLost).toFixed(1) : 0;
      const avgAge = totalLost > 0 ? Math.ceil(totalAge / totalLost) : 0;

      // Find highest loss reason
      let highestReasonStr = "N/A";
      let highestReasonCount = 0;
      for (const [r, count] of Object.entries(reasonsMap)) {
        if (count > highestReasonCount) {
          highestReasonCount = count;
          highestReasonStr = r;
        }
      }

      // Find highest loss stage
      let highestLossStageStr = "N/A";
      let highestLossStageCount = 0;
      for (const [stage, count] of Object.entries(stageDistribution)) {
        if (stage !== "Unknown" && count > highestLossStageCount) {
          highestLossStageCount = count;
          highestLossStageStr = stage;
        }
      }

      // Filter hot leads that need action
      const hotLeadsRejected = leads.filter(l => l.lossStage === "Hot");

      res.status(200).json({
        success: true,
        kpis: {
          totalLost,
          totalLeads,
          totalJunk,
          lossRate,
          stageDistribution,
          avgFollowUps,
          avgLeadAge: avgAge,
          highestReason: {
            reason: highestReasonStr,
            count: highestReasonCount
          },
          highestLossStage: {
            stage: highestLossStageStr,
            count: highestLossStageCount
          }
        },
        hotLeadsActionRequired: hotLeadsRejected,
        rawLeads: leads // Send raw array for the drag-and-drop dynamic chart builder
      });
    } catch (error) {
      console.error("Get Lead Loss Analytics Error:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
};
