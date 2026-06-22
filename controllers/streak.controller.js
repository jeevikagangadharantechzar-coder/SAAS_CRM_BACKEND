import mongoose from "mongoose";
import { getTenantModels } from "../models/tenant/index.js";
import StreakLegacy from "../models/streak.model.js";
import UserLegacy  from "../models/user.model.js";
import DealLegacy  from "../models/deals.model.js";
import LeadLegacy  from "../models/leads.model.js";
import RoleLegacy  from "../models/role.model.js";

const getModels = (req) =>
  req.tenantDB
    ? getTenantModels(req.tenantDB)
    : { Streak: StreakLegacy, User: UserLegacy, Deal: DealLegacy, Lead: LeadLegacy, Role: RoleLegacy };

function calcStreak(loginHistory) {
  if (!loginHistory?.length) return 0;
  const uniqueDates = [...new Set(loginHistory.filter(l => l?.login).map(l => new Date(l.login).toDateString()))].map(d => new Date(d)).sort((a, b) => b - a);
  if (!uniqueDates.length) return 0;
  const today = new Date(); today.setHours(0,0,0,0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const latest = new Date(uniqueDates[0]); latest.setHours(0,0,0,0);
  if (latest.getTime() !== today.getTime() && latest.getTime() !== yesterday.getTime()) return 0;
  let streak = 1;
  for (let i = 1; i < uniqueDates.length; i++) {
    const curr = new Date(uniqueDates[i-1]); curr.setHours(0,0,0,0);
    const prev = new Date(uniqueDates[i]);   prev.setHours(0,0,0,0);
    if (Math.round((curr - prev) / 86400000) === 1) streak++;
    else break;
  }
  return streak;
}

function formatTime(date) {
  if (!date) return null;
  return new Date(date).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
}

function calcWorkHours(loginHistory) {
  const todayStr = new Date().toDateString();
  const todayLogs = (loginHistory || []).filter(l => l?.login && new Date(l.login).toDateString() === todayStr);
  if (!todayLogs.length) return "—";
  const earliest = todayLogs.reduce((e, l) => new Date(l.login) < new Date(e.login) ? l : e);
  const logouts = todayLogs.filter(l => l.logout);
  if (!logouts.length) return `${formatTime(earliest.login)} - Ongoing`;
  const latest = logouts.reduce((e, l) => new Date(l.logout) > new Date(e.logout) ? l : e);
  return `${formatTime(earliest.login)} - ${formatTime(latest.logout)}`;
}

function getStatus(rate) {
  if (rate >= 70) return { status: "star",     statusIcon: "⭐", statusColor: "bg-yellow-100 text-yellow-800 border-yellow-200" };
  if (rate >= 50) return { status: "active",   statusIcon: "🔥", statusColor: "bg-green-100 text-green-800 border-green-200" };
  if (rate >= 30) return { status: "rising",   statusIcon: "🚀", statusColor: "bg-blue-100 text-blue-800 border-blue-200" };
  if (rate >  0)  return { status: "new",      statusIcon: "🆕", statusColor: "bg-gray-100 text-gray-800 border-gray-200" };
  return              { status: "inactive", statusIcon: "💤", statusColor: "bg-gray-100 text-gray-500 border-gray-200" };
}

export default {
  getUserLoginHistory: async (req, res) => {
    try {
      const { userId } = req.params;
      if (!userId || !mongoose.Types.ObjectId.isValid(userId))
        return res.status(400).json({ success: false, message: "Invalid userId" });
      const { User } = getModels(req);
      const currentUser = req.user;
      const isAdmin  = currentUser.role?.name === "Admin" || currentUser.role === "Admin";
      const isOwnData = currentUser._id.toString() === userId;
      if (!isAdmin && !isOwnData) return res.status(403).json({ message: "Access denied" });

      const user = await User.findById(userId).select("firstName lastName email loginHistory").lean();
      if (!user) return res.status(404).json({ message: "User not found" });

      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const loginHistory = (user.loginHistory || [])
        .filter(l => new Date(l.login) > thirtyDaysAgo)
        .sort((a, b) => new Date(b.login) - new Date(a.login));
      res.json({ success: true, loginHistory });
    } catch (error) {
      console.error("getUserLoginHistory error:", error);
      res.status(500).json({ success: false, message: "Error fetching login history", error: error.message });
    }
  },

  updateStreakFromLogin: async (req, res) => {
    try {
      const { Streak } = getModels(req);
      const { userId } = req.params;
      let streak = await Streak.findOne({ userId });
      if (!streak) streak = await Streak.create({ userId, currentStreak: 0, longestStreak: 0, productiveDays: 0 });

      const today = new Date(); const todayStr = today.toDateString();
      const lastStr = streak.lastLoginDate ? new Date(streak.lastLoginDate).toDateString() : null;
      if (lastStr !== todayStr) {
        const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
        streak.currentStreak = lastStr === yesterday.toDateString() ? (streak.currentStreak || 0) + 1 : 1;
        if (streak.currentStreak > (streak.longestStreak || 0)) streak.longestStreak = streak.currentStreak;
        streak.productiveDays = (streak.productiveDays || 0) + 1;
        streak.lastLoginDate  = today;
        await streak.save();
      }
      res.json({ success: true, streak: streak.currentStreak, productiveDays: streak.productiveDays, longestStreak: streak.longestStreak });
    } catch (error) {
      console.error("updateStreakFromLogin error:", error);
      res.status(500).json({ error: error.message });
    }
  },

  getLeaderboard: async (req, res) => {
    try {
      const currentUser = req.user;
      if (!currentUser) return res.status(401).json({ success: false, error: "Unauthorized" });
      const { User, Deal, Lead, Role } = getModels(req);
      const currentUserId = currentUser._id.toString();

      let userRoleName = "";
      if (typeof currentUser.role === "string") userRoleName = currentUser.role;
      else if (currentUser.role?.name) userRoleName = currentUser.role.name;
      else if (mongoose.Types.ObjectId.isValid(currentUser.role)) {
        try { const r = await Role.findById(currentUser.role).lean(); userRoleName = r?.name || ""; } catch (_) {}
      }

      const isAdmin = ["Admin","admin"].includes(userRoleName);
      const today = new Date();
      const rangeStart = req.query.startDate ? new Date(req.query.startDate) : new Date(today.getFullYear(), today.getMonth(), 1);
      const rangeEnd   = req.query.endDate   ? new Date(req.query.endDate)   : new Date(today);
      rangeStart.setHours(0,0,0,0); rangeEnd.setHours(23,59,59,999);

      const allUsers = await User.find({}).select("_id firstName lastName email role loginHistory createdAt").populate("role","name").lean();
      const salesUsers = allUsers.filter(u => { const rn = u.role?.name || u.role || ""; return typeof rn === "string" && rn.toLowerCase() === "sales"; });
      let targetUsers = isAdmin ? salesUsers : salesUsers.filter(u => u._id.toString() === currentUserId);

      if (!isAdmin && targetUsers.length === 0) {
        return res.json({ success: true, data: [], stats: { totalSalespeople:0, activeSalespeople:0, avgConversionRate:0, totalLeads:0, totalConvertedLeads:0, cumulativeTotalLeads:0 }, dateRange: { start:rangeStart, end:rangeEnd }, userRole:"sales" });
      }

      const userIds = targetUsers.map(u => u._id);
      const [allLeads, allDeals] = await Promise.all([
        Lead.find({ assignTo: { $in: userIds } }).select("_id assignTo createdAt").lean(),
        Deal.find({ assignedTo: { $in: userIds } }).select("_id assignedTo leadId createdAt convertedAt stage").lean(),
      ]);

      const leadsMap = {}; const dealsMap = {};
      targetUsers.forEach(u => { const id = u._id.toString(); leadsMap[id] = {range:0,cumulative:0}; dealsMap[id] = {rangeQ:0,rangeC:0,cumQ:0,cumC:0}; });
      allLeads.forEach(lead => { const id = lead.assignTo?.toString(); if (!leadsMap[id]) return; leadsMap[id].cumulative++; const d = new Date(lead.createdAt); if (d >= rangeStart && d <= rangeEnd) leadsMap[id].range++; });
      allDeals.forEach(deal => {
        const id = deal.assignedTo?.toString(); if (!dealsMap[id]) return;
        dealsMap[id].cumQ++; const d = new Date(deal.createdAt); if (d >= rangeStart && d <= rangeEnd) dealsMap[id].rangeQ++;
        if (deal.convertedAt) { dealsMap[id].cumC++; const cd = new Date(deal.convertedAt); if (cd >= rangeStart && cd <= rangeEnd) dealsMap[id].rangeC++; }
      });

      const rows = targetUsers.map(user => {
        const id = user._id.toString(); const lm = leadsMap[id]; const dm = dealsMap[id];
        const loginHistory = user.loginHistory || [];
        const rangeTotalLeads = lm.range + dm.rangeQ;
        const rangeConvRate   = rangeTotalLeads > 0 ? (dm.rangeC / rangeTotalLeads) * 100 : 0;
        const cumTotalLeads   = lm.cumulative + dm.cumQ;
        const cumConvRate     = cumTotalLeads > 0 ? (dm.cumC / cumTotalLeads) * 100 : 0;
        const rangeLoginDays  = new Set(loginHistory.filter(l => { if (!l?.login) return false; const d = new Date(l.login); return d >= rangeStart && d <= rangeEnd; }).map(l => new Date(l.login).toDateString()));
        const { status, statusIcon, statusColor } = getStatus(rangeConvRate);
        const displayName = (user.firstName || user.lastName) ? `${user.firstName||""} ${user.lastName||""}`.trim() : user.email?.split("@")[0] || "Unknown";
        return {
          id, name: displayName, email: user.email || "", role: user.role?.name || user.role || "Sales", team: user.team || "General Sales",
          avatar: (user.firstName?.charAt(0) || "U").toUpperCase(),
          totalLeads: rangeTotalLeads, rawLeads: lm.range, qualificationDeals: dm.rangeQ, convertedLeads: dm.rangeC,
          conversionRate: Number(rangeConvRate.toFixed(1)), conversionDisplay: `${rangeConvRate.toFixed(1)}%`,
          cumulativeTotalLeads: cumTotalLeads, cumulativeConvertedLeads: dm.cumC, cumulativeConversionRate: Number(cumConvRate.toFixed(1)), cumulativeDisplay: `${cumConvRate.toFixed(1)}%`,
          streak: calcStreak(loginHistory), productiveDays: rangeLoginDays.size, workHours: calcWorkHours(loginHistory),
          status, statusIcon, statusColor, performanceScore: Math.min(Math.round(rangeConvRate), 100), isCurrentUser: id === currentUserId,
        };
      });

      // Primary: most leads converted to qualification stage; Secondary: highest conversion rate (speed)
      const sorted = rows.filter(r => r.totalLeads > 0 || r.cumulativeTotalLeads > 0).sort((a, b) => b.qualificationDeals !== a.qualificationDeals ? b.qualificationDeals - a.qualificationDeals : b.conversionRate - a.conversionRate);
      const stats = {
        totalSalespeople: sorted.length, activeSalespeople: sorted.filter(r => r.conversionRate > 0).length,
        avgConversionRate: sorted.length ? Number((sorted.reduce((s,r) => s+r.conversionRate,0) / sorted.length).toFixed(1)) : 0,
        totalLeads: sorted.reduce((s,r) => s+r.totalLeads,0), totalConvertedLeads: sorted.reduce((s,r) => s+r.convertedLeads,0), cumulativeTotalLeads: sorted.reduce((s,r) => s+r.cumulativeTotalLeads,0),
      };
      res.json({ success: true, data: sorted, stats, dateRange: { start: rangeStart, end: rangeEnd, formatted: `${rangeStart.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})} - ${rangeEnd.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}` }, userRole: isAdmin ? "admin" : "sales" });
    } catch (error) {
      console.error("getLeaderboard FATAL ERROR:", error.message);
      res.status(500).json({ success: false, error: error.message, stack: error.stack });
    }
  },

  getUserStreak: async (req, res) => {
    try {
      const { Streak } = getModels(req);
      const streak = await Streak.findOne({ userId: req.params.userId }).populate("userId","firstName lastName email role team").lean();
      if (!streak) return res.status(404).json({ message: "Streak not found" });
      res.json(streak);
    } catch (error) { res.status(500).json({ error: error.message }); }
  },

  getSalesUsers: async (req, res) => {
    try {
      const { User } = getModels(req);
      const users = await User.find().populate("role","name").select("firstName lastName email role team createdAt");
      const salesUsers = users.filter(u => u.role?.name?.toLowerCase() === "sales");
      res.json({ success: true, users: salesUsers });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
  },
};
