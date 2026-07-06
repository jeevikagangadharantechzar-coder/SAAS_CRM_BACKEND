import { getTenantModels } from "../models/tenant/index.js";
import { getExchangeRate }  from "../services/currencyService.js";

// Legacy fallbacks
import LeadLegacy    from "../models/leads.model.js";
import DealLegacy    from "../models/deals.model.js";
import InvoiceLegacy from "../models/invoice.model.js";
import UserLegacy    from "../models/user.model.js";

const getModels = (req) => {
  if (req.tenantDB) return getTenantModels(req.tenantDB);
  return { Lead: LeadLegacy, Deal: DealLegacy, Invoice: InvoiceLegacy, User: UserLegacy };
};

// Statuses counted as revenue-generating (fully or partially collected)
const PAID_FAMILY = ["paid", "partially_paid"];

export default {
  getDashboardSummary: async (req, res) => {
    try {
      const { Lead, Deal, Invoice } = getModels(req);
      const { start, end } = req.query;
      let dateFilter = {};
      if (start || end) {
        dateFilter.createdAt = {};
        if (start) dateFilter.createdAt.$gte = new Date(start);
        if (end) { const e = new Date(end); e.setHours(23, 59, 59, 999); dateFilter.createdAt.$lte = e; }
      }

      const totalLeads = await Lead.countDocuments(dateFilter);

      let wonDateFilter = {};
      if (start || end) {
        wonDateFilter.wonAt = {};
        if (start) wonDateFilter.wonAt.$gte = new Date(start);
        if (end) { const e = new Date(end); e.setHours(23, 59, 59, 999); wonDateFilter.wonAt.$lte = e; }
      }

      const totalDealsWon = await Deal.countDocuments({ stage: "Closed Won", ...wonDateFilter });

      const userRole = req.user?.role?.name?.toLowerCase();
      const userId   = req.user?._id;

      const revenueByCurrency = {};
      let paidQuery = { status: { $in: PAID_FAMILY }, ...(dateFilter.createdAt && { createdAt: dateFilter.createdAt }) };
      if (userRole !== "admin") paidQuery.assignTo = userId;
      const paidInvoices = await Invoice.find(paidQuery);
      paidInvoices.forEach(inv => {
        const curr   = inv.currency;
        // Partially paid invoices only count the amount actually collected so far
        const amount = Number(inv.amountPaid) || Number(inv.total);
        const inrValue = inv.inrAmount || amount;
        if (!revenueByCurrency[curr]) revenueByCurrency[curr] = { amount: 0, inr: 0, count: 0 , preferredCurrency: inv.preferredCurrency, preferredCurrencyValue: 0};
        revenueByCurrency[curr].amount += amount;
        revenueByCurrency[curr].inr    += inrValue;
        revenueByCurrency[curr].count  += 1;
        revenueByCurrency[curr].preferredCurrencyValue += Number(inv.preferredCurrencyValue || 0);

      });

      const pendingInvoicesByCurrency = {};
      let pendingQuery = { status: "unpaid", ...(dateFilter.createdAt && { createdAt: dateFilter.createdAt }) };
      if (userRole !== "admin") pendingQuery.assignTo = userId;
      const pendingInvoices = await Invoice.find(pendingQuery);
      const pendingGrouped  = {};
      pendingInvoices.forEach(inv => {
        const curr   = inv.currency;
        const amount = Number(inv.total);
        if (!pendingGrouped[curr]) pendingGrouped[curr] = { amount: 0, count: 0 };
        pendingGrouped[curr].amount += amount;
        pendingGrouped[curr].count  += 1;
      });
      for (const [currency, data] of Object.entries(pendingGrouped)) {
        const rate    = await getExchangeRate(currency);
        const inrValue = data.amount * rate;
        pendingInvoicesByCurrency[currency] = { amount: data.amount, inr: inrValue, count: data.count };
      }

      res.json({ totalLeads, totalDealsWon, revenueByCurrency, pendingInvoicesByCurrency });
    } catch (error) {
      console.error("Dashboard summary error:", error);
      res.status(500).json({ message: "Server Error" });
    }
  },

  getStreakCard: async (req, res) => {
    try {
      const { Lead, Deal, User } = getModels(req);
      const today = new Date();
      const { start, end } = req.query;

      const rangeStart = start ? new Date(start) : new Date(today.getFullYear(), today.getMonth(), 1);
      const rangeEnd   = end   ? new Date(end)   : new Date(today);
      rangeStart.setHours(0, 0, 0, 0);
      rangeEnd.setHours(23, 59, 59, 999);

      const allUsers = await User.find({}).select("_id firstName lastName email role loginHistory").populate("role", "name").lean();
      const salesUsers = allUsers.filter(u => (u.role?.name || u.role || "").toLowerCase() === "sales");
      const userIds = salesUsers.map(u => u._id);

      const [allLeads, allDeals] = await Promise.all([
        Lead.find({ assignTo: { $in: userIds } }).select("_id assignTo createdAt status").lean(),
        Deal.find({ assignedTo: { $in: userIds } }).select("_id assignedTo createdAt convertedAt stage").lean(),
      ]);

      const leadsMap = {}, dealsMap = {};
      salesUsers.forEach(u => {
        const id = u._id.toString();
        leadsMap[id] = { range: 0, cumulative: 0 };
        dealsMap[id] = { rangeTotal: 0, cumTotal: 0, rangeQ: 0, rangeC: 0, cumQ: 0, cumC: 0 };
      });
      allLeads.forEach(lead => {
        const id = lead.assignTo?.toString();
        if (!leadsMap[id]) return;
        leadsMap[id].cumulative++;
        const d = new Date(lead.createdAt);
        const isUnfinished = lead.status?.toLowerCase() !== "converted";
        if (d >= rangeStart && d <= rangeEnd) {
          leadsMap[id].range++;
        } else if (d < rangeStart && isUnfinished) {
          leadsMap[id].range++;
        }
      });
      allDeals.forEach(deal => {
        const id = deal.assignedTo?.toString(); if (!dealsMap[id]) return;
        dealsMap[id].cumTotal++;
        const d = new Date(deal.createdAt); 
        if (d >= rangeStart && d <= rangeEnd) dealsMap[id].rangeTotal++;
        if (deal.stage === "Qualification") {
          dealsMap[id].cumQ++; if (d >= rangeStart && d <= rangeEnd) dealsMap[id].rangeQ++;
          if (deal.convertedAt) { dealsMap[id].cumC++; const cd = new Date(deal.convertedAt); if (cd >= rangeStart && cd <= rangeEnd) dealsMap[id].rangeC++; }
        }
      });

      const rows = salesUsers.map(u => {
        const id = u._id.toString(); const lm = leadsMap[id]; const dm = dealsMap[id];
        const rangeTotalLeads = lm.range + dm.rangeTotal;
        const rangeConvRate = rangeTotalLeads > 0 ? (dm.rangeC / rangeTotalLeads) * 100 : 0;
        const cumTotalLeads = lm.cumulative + dm.cumTotal;

        // Current login streak from loginHistory
        const loginHistory = u.loginHistory || [];
        const uniqueDates  = [...new Set(loginHistory.filter(l => l?.login).map(l => new Date(l.login).toDateString()))].map(d => new Date(d)).sort((a, b) => b - a);
        let streak = 0;
        if (uniqueDates.length) {
          const t = new Date(); t.setHours(0,0,0,0);
          const y = new Date(t); y.setDate(y.getDate() - 1);
          const latest = new Date(uniqueDates[0]); latest.setHours(0,0,0,0);
          if (latest.getTime() === t.getTime() || latest.getTime() === y.getTime()) {
            streak = 1;
            for (let i = 1; i < uniqueDates.length; i++) {
              const curr = new Date(uniqueDates[i-1]); curr.setHours(0,0,0,0);
              const prev = new Date(uniqueDates[i]);   prev.setHours(0,0,0,0);
              if (Math.round((curr - prev) / 86400000) === 1) streak++;
              else break;
            }
          }
        }

        const displayName = (u.firstName || u.lastName) ? `${u.firstName || ""} ${u.lastName || ""}`.trim() : u.email?.split("@")[0] || "Unknown";
        return { 
          id, name: displayName, email: u.email, 
          rawLeads: rangeTotalLeads, totalLeads: rangeTotalLeads, 
          qualificationDeals: dm.rangeQ, convertedLeads: dm.rangeC, 
          conversionRate: Number(rangeConvRate.toFixed(1)), 
          streak, cumulativeTotalLeads: cumTotalLeads 
        };
      });

      // Primary: highest conversion rate; Secondary: most total leads
      const sorted = rows
        .filter(r => r.totalLeads > 0 || r.convertedLeads > 0 || r.cumulativeTotalLeads > 0)
        .sort((a, b) => b.conversionRate !== a.conversionRate ? b.conversionRate - a.conversionRate : b.totalLeads - a.totalLeads);

      const stats = {
        totalSalespeople:  sorted.length,
        activeSalespeople: sorted.filter(r => r.qualificationDeals > 0).length,
        avgConversionRate: sorted.length ? Number((sorted.reduce((s, r) => s + r.conversionRate, 0) / sorted.length).toFixed(1)) : 0,
        totalQualification: sorted.reduce((s, r) => s + r.qualificationDeals, 0),
      };

      res.json({
        success: true,
        dateRange: { start: rangeStart, end: rangeEnd },
        stats,
        topPerformers: sorted.slice(0, 5),
        data: sorted,
      });
    } catch (error) {
      console.error("Streak card error:", error);
      res.status(500).json({ message: "Server Error" });
    }
  },

  getPipeline: async (req, res) => {
    try {
      const { Deal } = getModels(req);
      const { start, end } = req.query;
      let matchFilter = {};
      if (start || end) {
        matchFilter.createdAt = {};
        if (start) matchFilter.createdAt.$gte = new Date(start);
        if (end) { const e = new Date(end); e.setHours(23, 59, 59, 999); matchFilter.createdAt.$lte = e; }
      }
      const pipeline = await Deal.aggregate([
        { $match: matchFilter },
        { $group: { _id: "$stage", count: { $sum: 1 } } },
        { $project: { stage: "$_id", leads: "$count", _id: 0 } },
      ]);
      res.json(pipeline);
    } catch (err) {
      console.error("Pipeline error:", err);
      res.status(500).json({ message: err.message });
    }
  },
};
