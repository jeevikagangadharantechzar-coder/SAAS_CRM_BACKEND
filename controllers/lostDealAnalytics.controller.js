import { getTenantModels } from "../models/tenant/index.js";
import DealLegacy from "../models/deals.model.js";

const getModels = (req) =>
  req.tenantDB
    ? getTenantModels(req.tenantDB)
    : { Deal: DealLegacy };

// ---------------- Helper Functions ----------------
// Parse currency string to numeric value
const parseValue = (valueString) => {
  if (!valueString) return 0;
  if (typeof valueString === "number") return valueString;
  const numericValue = valueString.toString().replace(/[^0-9]/g, "");
  return parseInt(numericValue, 10) || 0;
};
// The frozen preferredCurrencyValue is only valid if it was actually converted
// to the currency the requesting user currently has set — otherwise it's a
// stale conversion into some other currency and must not be trusted.
const getPreferredValue = (deal, userCurrency) =>
  deal.preferredCurrency === userCurrency && deal.preferredCurrencyValue != null
    ? deal.preferredCurrencyValue
    : deal.parsedValue || 0;
// Aggregate lost deals into monthly trend data
const aggregateMonthlyTrend = (deals, timeframe) => {
  const trend = [];
  const now = new Date();

  let months;
  switch (timeframe) {
    case "week": months = 1; break;
    case "month": months = 3; break;
    case "quarter": months = 6; break;
    case "year": months = 12; break;
    default: months = 6;
  }

  for (let i = months - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setMonth(date.getMonth() - i);
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

    const monthDeals = deals.filter(deal => {
      const dealDate = new Date(deal.updatedAt);
      return dealDate.getMonth() === date.getMonth() && dealDate.getFullYear() === date.getFullYear();
    });

    trend.push({
      _id: monthKey,
      count: monthDeals.length,
      value: monthDeals.reduce((sum, deal) => sum + (deal.parsedValue || 0), 0),
      preferredValue: monthDeals.reduce((sum, deal) => sum + deal.preferredValueForUser, 0),
    });
  }

  return trend;
};
// Calculate distribution of loss reasons across lost deals
const aggregateReasonDistribution = (deals) => {
  const distribution = {};
  deals.forEach(deal => {
    const reason = deal.lossReason || "Unknown";
    distribution[reason] = (distribution[reason] || 0) + 1;
  });

  return Object.entries(distribution)
    .map(([reason, count]) => ({ _id: reason, count }))
    .sort((a, b) => b.count - a.count);
};
// Identify top 5 users with most lost deals
const aggregateTopLostUsers = (deals) => {
  const userStats = {};
  deals.forEach(deal => {
    if (deal.assignedTo) {
      const userId = deal.assignedTo._id?.toString();
      if (userId) {
        if (!userStats[userId]) {
          userStats[userId] = {
            _id: userId,
            lostDeals: 0,
            lostValue: 0,
            firstName: deal.assignedTo.firstName,
            lastName: deal.assignedTo.lastName,
            email: deal.assignedTo.email,
          };
        }
        userStats[userId].lostDeals++;
        userStats[userId].lostValue += deal.parsedValue || 0;
      }
    }
  });

  return Object.values(userStats)
    .sort((a, b) => b.lostDeals - a.lostDeals)
    .slice(0, 5);
};
// Analyze lost deals by industry vertical
const aggregateIndustryAnalysis = (deals) => {
  const industryStats = {};
  deals.forEach(deal => {
    const industry = deal.industry || "Other";
    if (!industryStats[industry]) {
      industryStats[industry] = { _id: industry, count: 0, value: 0, preferredValue: 0 };
    }
    industryStats[industry].count++;
    industryStats[industry].value += deal.parsedValue || 0;
    industryStats[industry].preferredValue += deal.preferredValueForUser;
  });
  return Object.values(industryStats).sort((a, b) => b.value - a.value);
};
// Categorize lost deals by deal size
const aggregateDealSizeAnalysis = (deals) => {
  const sizes = {
    small: { count: 0, value: 0 },
    medium: { count: 0, value: 0 },
    large: { count: 0, value: 0 },
    enterprise: { count: 0, value: 0 },
  };

  deals.forEach(deal => {
    const value = deal.parsedValue || 0;
    if (value < 50000) sizes.small.count++, sizes.small.value += value;
    else if (value < 200000) sizes.medium.count++, sizes.medium.value += value;
    else if (value < 500000) sizes.large.count++, sizes.large.value += value;
    else sizes.enterprise.count++, sizes.enterprise.value += value;
  });

  return Object.entries(sizes).map(([size, data]) => ({
    _id: size,
    count: data.count,
    value: data.value,
  }));
};
// Calculate statistical metrics 
const calculateStatisticalAnalysis = (deals, monthlyTrend) => {
  if (!deals.length) return { avgDealValue: 0, medianDealValue: 0, stdDeviation: 0, winRate: 0, lossRate: 0, trend: "stable", predictedLosses: 0 };

  const values = deals.map(deal => deal.parsedValue || 0);
  const avgDealValue = Math.round(values.reduce((a, b) => a + b, 0) / values.length);

  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];

  const squareDiffs = values.map(v => Math.pow(v - avgDealValue, 2));
  const stdDeviation = Math.round(Math.sqrt(squareDiffs.reduce((a, b) => a + b, 0) / squareDiffs.length));

  let trend = "stable";
  if (monthlyTrend.length >= 2) {
    const lastMonth = monthlyTrend[monthlyTrend.length - 1]?.count || 0;
    const prevMonth = monthlyTrend[monthlyTrend.length - 2]?.count || 0;
    if (lastMonth > prevMonth) trend = "increasing";
    else if (lastMonth < prevMonth) trend = "decreasing";
  }

  const avgMonthlyLosses = monthlyTrend.length ? Math.round(monthlyTrend.reduce((sum, m) => sum + m.count, 0) / monthlyTrend.length) : deals.length;

  return { avgDealValue, medianDealValue: Math.round(median), stdDeviation, winRate: 0, lossRate: deals.length ? 100 : 0, trend, predictedLosses: avgMonthlyLosses };
};

// Updated recovery rates for your 5 stages
const getStageRecoveryRate = (stage) => {
  const rates = {
    "Qualification": 15,
    "Proposal Sent-Negotiation": 25,
    "Invoice Sent": 45,
    "Closed Won": 0,
    "Closed Lost": 0,
    "Unknown": 10,
  };
  return rates[stage] || 10;
};
// Calculate the stage for analysis
const calculateStageAnalysis = (deals) => {
  const stageMap = new Map();
 
  const stageOrder = ["Qualification", "Proposal Sent-Negotiation", "Invoice Sent", "Closed Won", "Closed Lost"];

  deals.forEach(deal => {
    const stage = deal.stageLostAt || deal.stage || "Unknown";
    const value = deal.parsedValue || 0;
    if (!stageMap.has(stage)) stageMap.set(stage, { stage, count: 0, totalValue: 0 });
    const stageData = stageMap.get(stage);
    stageData.count += 1;
    stageData.totalValue += value;
  });

  const totalDeals = deals.length;
  const totalValue = deals.reduce((sum, d) => sum + (d.parsedValue || 0), 0);

  return Array.from(stageMap.values())
    .map(stage => ({
      ...stage,
      percentage: totalDeals ? Math.round((stage.count / totalDeals) * 100) : 0,
      valuePercentage: totalValue ? Math.round((stage.totalValue / totalValue) * 100) : 0,
      recoveryRate: getStageRecoveryRate(stage.stage),
    }))
    .sort((a, b) => {
      const indexA = stageOrder.indexOf(a.stage);
      const indexB = stageOrder.indexOf(b.stage);
      if (indexA === -1 && indexB === -1) return 0;
      if (indexA === -1) return 1;
      if (indexB === -1) return -1;
      return indexA - indexB;
    });
};

// ---------------- Controller ----------------
export default {
  //get the lost deal and analyse it
  getLostDealAnalytics: async (req, res) => {
    try {
      const { Deal } = getModels(req);
      const { timeframe = "month", startDate, endDate, reason, assignedTo, industry } = req.query;
      const userId = req.user?._id;
      const userRole = req.user?.role?.name;
      const userCurrency = req.user?.currency || "USD";

      let dateFilter = {};
      if (startDate || endDate) {
        dateFilter.updatedAt = {};
        if (startDate) dateFilter.updatedAt.$gte = new Date(startDate);
        if (endDate) dateFilter.updatedAt.$lte = new Date(endDate);
      } else {
        const now = new Date();
        switch (timeframe) {
          case "week": dateFilter.updatedAt = { $gte: new Date(now.setDate(now.getDate() - 7)) }; break;
          case "month": dateFilter.updatedAt = { $gte: new Date(now.setMonth(now.getMonth() - 1)) }; break;
          case "quarter": dateFilter.updatedAt = { $gte: new Date(now.setMonth(now.getMonth() - 3)) }; break;
          case "year": dateFilter.updatedAt = { $gte: new Date(now.setFullYear(now.getFullYear() - 1)) }; break;
          case "all": default: dateFilter = {}; break;
        }
      }

      // Query only Closed Lost deals
      let dealQuery = { stage: "Closed Lost" };
      if (Object.keys(dateFilter).length) dealQuery = { ...dealQuery, ...dateFilter };
      if (reason) dealQuery.lossReason = reason;
      if (industry) dealQuery.industry = industry;
      if (assignedTo) dealQuery.assignedTo = assignedTo;
      if (userRole !== "Admin") dealQuery.assignedTo = userId;

      const lostDeals = await Deal.find(dealQuery)
        .populate("assignedTo", "firstName lastName email")
        .populate("leadId")
        .sort({ updatedAt: -1 });

      const enhancedLostDeals = lostDeals.map(d => {
        const dealObj = d.toObject();
        const parsedValue = parseValue(dealObj.value);
        const preferredValueForUser = getPreferredValue(
          { parsedValue, preferredCurrency: dealObj.preferredCurrency, preferredCurrencyValue: dealObj.preferredCurrencyValue },
          userCurrency
        );
        return {
          ...dealObj,
          parsedValue,
          preferredCurrency: dealObj.preferredCurrency || null,
          preferredCurrencyValue: dealObj.preferredCurrencyValue ?? null,
          preferredValueForUser,
          stageLostAt: dealObj.stageLostAt || dealObj.stage || "Unknown",
          daysInPipeline: Math.round((new Date(dealObj.updatedAt) - new Date(dealObj.createdAt)) / (1000 * 60 * 60 * 24)) || 0,
        };
      });

      const totalLostDeals = enhancedLostDeals.length;
      const totalLostValue = enhancedLostDeals.reduce((sum, d) => sum + (d.parsedValue || 0), 0);
      
      // Calculate deals lost at Invoice Sent stage
      const invoiceSentDeals = enhancedLostDeals.filter(deal => 
        deal.stageLostAt === "Invoice Sent"
      );
      const invoiceSentCount = invoiceSentDeals.length;
      const invoiceSentValue = invoiceSentDeals.reduce((sum, deal) => sum + deal.parsedValue, 0);
      const invoiceSentPreferredValue = invoiceSentDeals.reduce(
        (sum, deal) => sum + deal.preferredValueForUser,
        0
      );
      const invoiceSentPercentage = totalLostDeals > 0 ? Math.round((invoiceSentCount / totalLostDeals) * 100) : 0;

      const monthlyTrend = aggregateMonthlyTrend(enhancedLostDeals, timeframe);
      const reasonDistribution = aggregateReasonDistribution(enhancedLostDeals);
      const topLostUsers = aggregateTopLostUsers(enhancedLostDeals);
      const recentLostDeals = enhancedLostDeals;
      const industryAnalysis = aggregateIndustryAnalysis(enhancedLostDeals);
      const dealSizeAnalysis = aggregateDealSizeAnalysis(enhancedLostDeals);
      const highValueDeals = enhancedLostDeals.filter(d => (d.parsedValue || 0) >= 100000).sort((a, b) => (b.parsedValue || 0) - (a.parsedValue || 0)).slice(0, 10);
      const statisticalAnalysis = calculateStatisticalAnalysis(enhancedLostDeals, monthlyTrend);
      const stageAnalysis = calculateStageAnalysis(enhancedLostDeals);

      res.status(200).json({
        success: true,
        data: {
          totalLostDeals,
          totalLostValue,
          invoiceSentDeals: {
            count: invoiceSentCount,
            value: invoiceSentValue,
            preferredValue: invoiceSentPreferredValue,
            percentage: invoiceSentPercentage
          },
          monthlyTrend,
          reasonDistribution,
          topLostUsers,
          recentLostDeals,
          industryAnalysis,
          dealSizeAnalysis,
          highValueDeals,
          statisticalAnalysis,
          stageAnalysis,
        },
      });
    } catch (error) {
      console.error("Lost Deal Analytics Error:", error);
      res.status(500).json({ success: false, message: "Failed to fetch lost deal analytics", error: error.message });
    }
  },
  //export the lost deal as a report
  exportLostDealReport: async (req, res) => {
    try {
      const { Deal } = getModels(req);
      const { format = "csv", timeframe = "month" } = req.query;
      const now = new Date();
      let dateFilter = {};
      switch (timeframe) {
        case "week": dateFilter.updatedAt = { $gte: new Date(now.setDate(now.getDate() - 7)) }; break;
        case "month": dateFilter.updatedAt = { $gte: new Date(now.setMonth(now.getMonth() - 1)) }; break;
        case "quarter": dateFilter.updatedAt = { $gte: new Date(now.setMonth(now.getMonth() - 3)) }; break;
        case "year": dateFilter.updatedAt = { $gte: new Date(now.setFullYear(now.getFullYear() - 1)) }; break;
        default: dateFilter = {};
      }

      const dealQuery = { stage: "Closed Lost", ...dateFilter };
      const lostDeals = await Deal.find(dealQuery).populate("assignedTo", "firstName lastName email").sort({ updatedAt: -1 });

      if (format === "csv") {
        let csv = "Date Lost,Deal Name,Stage Lost At,Value,Loss Reason,Owner\n";
        lostDeals.forEach(deal => {
          const row = [
            new Date(deal.updatedAt).toISOString().split('T')[0],
            `"${deal.dealName || 'Unnamed'}"`,
            deal.stageLostAt || deal.stage || 'Unknown',
            parseValue(deal.value),
            `"${deal.lossReason || 'Unknown'}"`,
            deal.assignedTo ? `${deal.assignedTo.firstName} ${deal.assignedTo.lastName}` : 'Unassigned'
          ].join(',');
          csv += row + '\n';
        });

        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename=lost-deals-${new Date().toISOString().split('T')[0]}.csv`);
        res.status(200).send(csv);
      } else {
        res.status(200).json({ success: true, message: "PDF generation not implemented yet" });
      }
    } catch (error) {
      console.error("Export Error:", error);
      res.status(500).json({ success: false, message: "Failed to export report", error: error.message });
    }
  }
};