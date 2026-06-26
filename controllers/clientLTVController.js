import { getTenantModels } from "../models/tenant/index.js";
import ClientLTVLegacy     from "../models/ClientLTV.js";
import DealLegacy          from "../models/deals.model.js";
import SupportTicketLegacy from "../models/SupportTicket.js";
import RenewalLegacy       from "../models/Renewal.js";
import ClientReviewLegacy  from "../models/ClientReview.js";
import PricingRisk         from "../models/PricingRisk.js"; // not a tenant model

const getLTVModels = (req) => {
  if (req?.tenantDB) {
    const { ClientLTV, Deal, SupportTicket, Renewal, ClientReview } = getTenantModels(req.tenantDB);
    return { ClientLTV, Deal, SupportTicket, Renewal, ClientReview, PricingRisk };
  }
  return { ClientLTV: ClientLTVLegacy, Deal: DealLegacy, SupportTicket: SupportTicketLegacy, Renewal: RenewalLegacy, ClientReview: ClientReviewLegacy, PricingRisk };
};

// ── Internal helpers (accept models as last param) ──────────────────────────

async function getSupportMetrics(companyId, SupportTicket) {
  const tickets = await SupportTicket.find({ companyId }).sort({ openedAt: -1 }).lean();
  const total = tickets.length;
  const open  = tickets.filter(t => t.status === "Open").length;
  const lastSupportDate = total > 0 ? tickets[0].openedAt : null;
  const supportPoints = Math.max(0, 100 - (total * 5));
  let avgResolutionHours = 0;
  const closed = tickets.filter(t => t.status === "Closed" && t.resolutionTimeHours);
  if (closed.length > 0)
    avgResolutionHours = closed.reduce((s, t) => s + (t.resolutionTimeHours || 0), 0) / closed.length;
  const sixMonthsAgo = new Date(); sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const perMonth = tickets.filter(t => new Date(t.openedAt) >= sixMonthsAgo).length / 6;
  return { total, open, lastSupportDate, avgResolutionHours, perMonth, supportPoints };
}

async function getFollowUpMetrics(dealId, Deal) {
  const deal = await Deal.findById(dealId).lean();
  if (!deal) return { count: 0, lastDate: null, daysSince: 365 };
  const followUpCount = deal.followUpHistory?.length || 0;
  let lastFollowUpDate = null;
  if (deal.followUpHistory?.length > 0) {
    const sorted = [...deal.followUpHistory].sort((a, b) => (b.date ? new Date(b.date).getTime() : 0) - (a.date ? new Date(a.date).getTime() : 0));
    lastFollowUpDate = sorted[0]?.date || null;
  } else if (deal.followUpDate) {
    lastFollowUpDate = deal.followUpDate;
  }
  return { count: followUpCount, lastDate: lastFollowUpDate, daysSince: calcDaysSince(lastFollowUpDate) };
}

const calcDaysSince = (date) => {
  if (!date) return 365;
  const d = new Date(date); const now = new Date();
  d.setHours(0,0,0,0); now.setHours(0,0,0,0);
  return Math.max(0, Math.floor((now - d) / 86400000));
};

const classifyDeal = ({ totalRevenue=0, supportTickets=0, clientHealthScore=50, daysSinceFollowUp=0, progress="average" }) => {
  totalRevenue = Number(totalRevenue) || 0;
  supportTickets = Number(supportTickets) || 0;
  clientHealthScore = Math.min(100, Math.max(0, Number(clientHealthScore) || 50));
  daysSinceFollowUp = Math.max(0, Number(daysSinceFollowUp) || 0);
  const np = String(progress).trim().toLowerCase();
  if (daysSinceFollowUp > 90) return "Dormant";
  if (np === "excellent" && totalRevenue >= 500000 && clientHealthScore >= 80 && supportTickets <= 2 && daysSinceFollowUp <= 30) return "Upsell";
  if (np === "poor" || clientHealthScore < 70 || supportTickets >= 5 || daysSinceFollowUp > 30) return "At Risk";
  return "Top Value";
};

const getValueCategory = (amount) => {
  if (amount > 500000) return "High Value";
  if (amount >= 100000) return "Medium Value";
  return "Low Value";
};

const calcPricing = ({ progress, supportTickets, clientHealthScore, totalRevenue, delivered }) => {
  const np = String(progress).trim().toLowerCase();
  const progDisc = np === "excellent" || np === "good" ? 30 : np === "average" ? 20 : 0;
  const suppDisc = supportTickets > 10 ? 0 : supportTickets > 5 ? 20 : 30;
  const healthDisc = clientHealthScore > 75 ? 30 : clientHealthScore > 50 ? 20 : 0;
  const delivBonus = delivered ? 15 : 0;
  const finalDiscount = Math.min(Math.round(([progDisc, suppDisc, healthDisc, delivBonus].reduce((a,b)=>a+b,0)) / 4), 50);
  const confidence = supportTickets < 3 && np === "excellent" ? 90 : supportTickets > 10 || np === "poor" ? 50 : 70;
  return { suggestedMinPrice: Math.round(totalRevenue * (1 - finalDiscount/100)), suggestedMaxPrice: Math.round(totalRevenue * 1.1), recommendedDiscount: finalDiscount, confidenceScore: confidence, deliveryBonus: delivBonus };
};

const buildReason = (classification, { totalRevenue, supportTickets, clientHealthScore, daysSinceFollowUp }, riskFactors) => {
  switch(classification) {
    case "Upsell": return `Upsell: ${supportTickets} tickets, revenue > ₹500k, health ${clientHealthScore}`;
    case "Top Value": return `Top value: revenue > ₹500k, ${supportTickets} tickets, health ${clientHealthScore}, recent follow-up`;
    case "Dormant": return `Dormant: ${supportTickets} tickets, value < ₹500k, no follow-up for ${daysSinceFollowUp} days`;
    default: return riskFactors.length > 0 ? `At risk: ${riskFactors.join(", ")}` : `At risk: Health score ${clientHealthScore}, ${daysSinceFollowUp} days inactive, ${supportTickets} tickets`;
  }
};

async function recalculateMetricsFromDeal(companyId, companyName, models) {
  const { Deal, ClientLTV, ClientReview, SupportTicket } = models;
  const deal = await Deal.findById(companyId).lean();
  if (!deal) return null;
  if (deal.stage !== "Closed Won") { await ClientLTV.findOneAndDelete({ companyId }); return null; }

  const latestReview   = await ClientReview.findOne({ companyId }).sort({ reviewedAt: -1 }).lean();
  const numericMatch   = deal.value?.toString().match(/\d+/g);
  const totalRevenue   = numericMatch ? parseInt(numericMatch.join("")) : 0;
  const supportMetrics = await getSupportMetrics(companyId, SupportTicket);
  const followUpM      = await getFollowUpMetrics(companyId, Deal);
  const progress       = latestReview?.progress || "Average";
  const clientHealthScore = latestReview?.clientHealthScore || 50;
  const delivered      = latestReview?.delivered || false;

  const metrics = { totalRevenue, supportTickets: supportMetrics.total, clientHealthScore, daysSinceFollowUp: followUpM.daysSince, progress };
  const classification = classifyDeal(metrics);
  const riskFactors = [];
  if (followUpM.daysSince > 60) riskFactors.push(`No follow-up for ${followUpM.daysSince} days`);
  if (supportMetrics.total > 10) riskFactors.push(`${supportMetrics.total} support tickets`);
  if (clientHealthScore < 50) riskFactors.push(`Low health score: ${clientHealthScore}`);
  const reason = buildReason(classification, { ...metrics }, riskFactors);
  const pricing = calcPricing({ progress, supportTickets: supportMetrics.total, clientHealthScore, totalRevenue, delivered });

  let ltv = await ClientLTV.findOne({ companyId });
  if (!ltv) ltv = new ClientLTV({ companyId, companyName });
  Object.assign(ltv, {
    totalRevenue, totalDeals: 1, lastFollowUpDate: followUpM.lastDate, daysSinceFollowUp: followUpM.daysSince,
    totalSupportTickets: supportMetrics.total, supportPoints: supportMetrics.supportPoints, followUpCount: followUpM.count,
    openSupportTickets: supportMetrics.open, lastSupportDate: supportMetrics.lastSupportDate, riskFactors,
    classification, classificationReason: reason, valueCategory: getValueCategory(totalRevenue),
    customerLifetimeValue: totalRevenue, clientHealthScore, delivered, progress,
    ...(latestReview && { latestReview: latestReview._id }),
    suggestedMinPrice: pricing.suggestedMinPrice, suggestedMaxPrice: pricing.suggestedMaxPrice,
    recommendedDiscount: pricing.recommendedDiscount, lastClassificationUpdate: new Date(),
  });
  await ltv.save();
  return ltv;
}

async function calculateMetricsFromReview(companyId, companyName, reviewData, models) {
  const { Deal, ClientLTV, SupportTicket } = models;
  const deal = await Deal.findById(companyId).lean();
  if (!deal) return null;
  const numericMatch   = deal.value?.toString().match(/\d+/g);
  const totalRevenue   = numericMatch ? parseInt(numericMatch.join("")) : 0;
  const supportTickets = reviewData.supportTickets !== undefined ? reviewData.supportTickets : 0;
  const supportMetrics = await getSupportMetrics(companyId, SupportTicket);
  const followUpM      = await getFollowUpMetrics(companyId, Deal);
  const metrics = { totalRevenue, supportTickets, clientHealthScore: reviewData.clientHealthScore || 50, daysSinceFollowUp: followUpM.daysSince, progress: reviewData.progress };
  const classification = classifyDeal(metrics);
  const riskFactors = [];
  if (followUpM.daysSince > 60) riskFactors.push(`No follow-up for ${followUpM.daysSince} days`);
  if (supportTickets > 10) riskFactors.push(`${supportTickets} support tickets`);
  if (reviewData.clientHealthScore < 50) riskFactors.push(`Low health score: ${reviewData.clientHealthScore}`);
  const reason = buildReason(classification, metrics, riskFactors);
  const pricing = calcPricing({ progress: reviewData.progress, supportTickets, clientHealthScore: reviewData.clientHealthScore, totalRevenue, delivered: reviewData.delivered });

  let ltv = await ClientLTV.findOne({ companyId });
  if (!ltv) ltv = new ClientLTV({ companyId, companyName });
  Object.assign(ltv, {
    totalRevenue, totalDeals: 1, lastFollowUpDate: followUpM.lastDate, daysSinceFollowUp: followUpM.daysSince,
    totalSupportTickets: supportTickets, supportPoints: supportMetrics.supportPoints, followUpCount: followUpM.count,
    openSupportTickets: supportMetrics.open, lastSupportDate: supportMetrics.lastSupportDate, riskFactors,
    classification, classificationReason: reason, valueCategory: getValueCategory(totalRevenue),
    customerLifetimeValue: totalRevenue, clientHealthScore: reviewData.clientHealthScore,
    delivered: reviewData.delivered === true, progress: reviewData.progress, latestReview: reviewData._id,
    suggestedMinPrice: pricing.suggestedMinPrice, suggestedMaxPrice: pricing.suggestedMaxPrice,
    recommendedDiscount: pricing.recommendedDiscount, lastClassificationUpdate: new Date(),
  });
  await ltv.save();
  return ltv;
}

// ── Controller methods ────────────────────────────────────────────────────────

export default {
  calculateClientCLV: async (req, res) => {
    try {
      const models = getLTVModels(req);
      const { ClientLTV, Deal, ClientReview } = models;
      const decodedName = decodeURIComponent(req.params?.companyName || req || "");
      const deal = await Deal.findOne({ companyName: decodedName }).lean();
      if (!deal) return res?.status(404).json({ success: false, message: "No deal found for this company" });
      if (deal.stage !== "Closed Won") {
        await ClientLTV.findOneAndDelete({ companyId: deal._id });
        return res?.json({ success: true, message: "Deal is not Closed Won - removed from CLV", data: null });
      }
      const latestReview = await ClientReview.findOne({ companyId: deal._id }).sort({ reviewedAt: -1 }).lean();
      if (!latestReview) return res?.status(404).json({ success: false, message: "No review found for this client" });
      const result = await calculateMetricsFromReview(deal._id, decodedName, latestReview, models);
      res?.json({ success: true, data: result, message: "CLV calculated successfully" });
    } catch (error) {
      console.error("Error in calculateClientCLV controller:", error);
      res?.status(500).json({ success: false, message: error.message });
    }
  },

  getWonDeals: async (req, res) => {
    try {
      const { Deal, ClientReview, ClientLTV } = getLTVModels(req);
      const { page=1, limit=10, classification="all", showUnreviewedFirst="true", search="" } = req.query;
      const pageNum = parseInt(page); const limitNum = parseInt(limit); const skip = (pageNum-1)*limitNum;
      const calcDays = (d) => { if (!d) return 0; const a=new Date(d),b=new Date(); a.setHours(0,0,0,0); b.setHours(0,0,0,0); return Math.max(0,Math.floor((b-a)/86400000)); };
      let searchQuery = { stage: "Closed Won" };
      if (search?.trim()) { const r = new RegExp(search.trim(),"i"); searchQuery = { ...searchQuery, $or: [{ dealName: r },{ companyName: r }] }; }
      const totalDeals = await Deal.countDocuments(searchQuery);
      if (totalDeals === 0) return res.json({ success: true, data: [], pagination: { total:0, page:pageNum, pages:0, unreviewedCount:0 } });

      const deals = await Deal.find(searchQuery).select("_id dealName companyName value assignedTo wonAt createdAt followUpDate followUpHistory")
        .populate("assignedTo","firstName lastName").sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean();
      const dealIds = deals.map(d => d._id.toString());
      const [reviews, clvData] = await Promise.all([
        ClientReview.find({ companyId: { $in: dealIds } }).select("companyId").lean(),
        ClientLTV.find({ companyId: { $in: dealIds } }).lean(),
      ]);
      const reviewedIds = new Set(reviews.map(r => r.companyId.toString()));
      const clvMap = {}; clvData.forEach(c => { if (c.companyId) clvMap[c.companyId.toString()] = c; });

      let formatted = deals.map(deal => {
        const id = deal._id.toString(); const clvEntry = clvMap[id]; const hasReview = reviewedIds.has(id);
        let daysSince = 0;
        if (clvEntry?.lastFollowUpDate) daysSince = calcDays(clvEntry.lastFollowUpDate);
        else if (deal.followUpDate) daysSince = calcDays(deal.followUpDate);
        else if (deal.followUpHistory?.length > 0) {
          const s = [...deal.followUpHistory].sort((a,b) => (b.date?new Date(b.date).getTime():0)-(a.date?new Date(a.date).getTime():0));
          if (s[0]?.date) daysSince = calcDays(s[0].date);
        }
        return { _id: deal._id, clientName: deal.dealName||"Unnamed", companyName: deal.companyName||"Unknown", companyId: deal._id, dealId: deal._id, dealValue: deal.value||"0",
          delivered: clvEntry?.delivered===true, assignedTo: deal.assignedTo ? `${deal.assignedTo.firstName||""} ${deal.assignedTo.lastName||""}`.trim() : "Unassigned",
          salespersonId: deal.assignedTo?._id, supportTicketCount: clvEntry?.totalSupportTickets||0, daysSinceFollowUp: daysSince,
          reviewProgress: clvEntry?.progress||null, classification: clvEntry?.classification||"At Risk", clientHealthScore: clvEntry?.clientHealthScore||50,
          reviewStatus: hasReview?"Submitted":"Pending", hasReview, createdAt: deal.createdAt, followUpDate: deal.followUpDate };
      });
      if (classification !== "all") formatted = formatted.filter(d => d.classification === classification);
      if (showUnreviewedFirst === "true") formatted.sort((a,b) => a.hasReview!==b.hasReview ? (a.hasReview?1:-1) : new Date(b.createdAt||0)-new Date(a.createdAt||0));
      else formatted.sort((a,b) => new Date(b.createdAt||0)-new Date(a.createdAt||0));

      const allIds = (await Deal.find(searchQuery).select("_id").lean()).map(d => d._id.toString());
      const allReviewed = new Set((await ClientReview.find({ companyId: { $in: allIds } }).select("companyId").lean()).map(r => r.companyId.toString()));
      const unreviewedCount = allIds.filter(id => !allReviewed.has(id)).length;
      res.json({ success: true, data: formatted, pagination: { total: totalDeals, page: pageNum, pages: Math.ceil(totalDeals/limitNum), unreviewedCount, limit: limitNum } });
    } catch (error) {
      console.error("Error in getWonDeals:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  createClientReview: async (req, res) => {
    try {
      const models = getLTVModels(req);
      const { ClientReview, Deal } = models;
      const { companyId, companyName, clientName, dealId, dealValue, delivered, salespersonId, salespersonName, supportTickets, progress, reviewNotes, clientHealthScore } = req.body;
      if (!companyId || !companyName || !clientName || !dealId) return res.status(400).json({ success: false, message: "Missing required fields" });
      const userId = req.user?._id || req.user?.id;
      const reviewData = { companyId, companyName, clientName, dealId, dealValue: parseFloat(String(dealValue||"0").replace(/[^0-9.-]+/g,""))||0, delivered: delivered===true, salespersonId, salespersonName, supportTickets: parseInt(supportTickets)||0, progress: progress||"Average", reviewNotes: reviewNotes||"", clientHealthScore: parseInt(clientHealthScore)||50, reviewedAt: new Date(), reviewedBy: userId };
      const review = await ClientReview.findOneAndUpdate({ companyId }, reviewData, { new: true, upsert: true });
      await Deal.findByIdAndUpdate(dealId, { clientReviewId: review._id });
      const updatedClient = await calculateMetricsFromReview(companyId, companyName, { ...review.toObject(), delivered: reviewData.delivered, supportTickets: reviewData.supportTickets }, models);
      res.status(201).json({ success: true, data: { review, client: updatedClient }, message: "Review saved successfully. Client metrics calculated." });
    } catch (error) {
      console.error("Error in createClientReview:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  syncFollowUpData: async (req, res) => {
    try {
      const models = getLTVModels(req);
      const { Deal } = models;
      const decodedName = decodeURIComponent(req.params.companyName);
      const deal = await Deal.findOne({ companyName: decodedName }).lean();
      if (!deal) return res.status(404).json({ success: false, message: "No deal found for this company" });
      if (deal.stage !== "Closed Won") return res.json({ success: true, message: "Deal is not Closed Won - no CLV data to update", data: null });
      const followUpMetrics = await getFollowUpMetrics(deal._id, Deal);
      const updatedClient = await recalculateMetricsFromDeal(deal._id, decodedName, models);
      res.json({ success: true, data: { followUpCount: followUpMetrics.count, lastFollowUpDate: followUpMetrics.lastDate, daysSinceFollowUp: followUpMetrics.daysSince, client: updatedClient }, message: "Follow-up data synced successfully." });
    } catch (error) {
      console.error("Error in syncFollowUpData:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  refreshClientMetrics: async (req, res) => {
    try {
      const models = getLTVModels(req);
      const { Deal } = models;
      const decodedName = decodeURIComponent(req.params.companyName);
      const deal = await Deal.findOne({ companyName: decodedName }).lean();
      if (!deal) return res.status(404).json({ success: false, message: "No deal found for this company" });
      const updatedClient = await recalculateMetricsFromDeal(deal._id, decodedName, models);
      res.json({ success: true, data: updatedClient, message: "Client metrics refreshed successfully" });
    } catch (error) {
      console.error("Error in refreshClientMetrics:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  getCLVDashboard: async (req, res) => {
    try {
      const { ClientLTV, Deal, ClientReview } = getLTVModels(req);
      // Cleanup invalid clients
      const activeIds = await Deal.find({ stage: "Closed Won" }).distinct("_id");
      const cleaned = await ClientLTV.deleteMany({ companyId: { $nin: activeIds } });
      if (cleaned.deletedCount > 0) console.log(`Cleaned up ${cleaned.deletedCount} invalid clients`);

      const clients = await ClientLTV.find().populate("latestReview").lean();
      const withDays = clients.map(c => {
        const days = c.lastFollowUpDate ? calcDaysSince(c.lastFollowUpDate) : 365;
        return { ...c, daysSinceFollowUp: days, classification: classifyDeal({ totalRevenue: c.customerLifetimeValue||0, supportTickets: c.totalSupportTickets||0, clientHealthScore: c.clientHealthScore||50, daysSinceFollowUp: days, progress: c.progress||"Average" }) };
      });

      const cc = { "Upsell":0,"Top Value":0,"Dormant":0,"At Risk":0 };
      const vc = { "High Value":0,"Medium Value":0,"Low Value":0 };
      withDays.forEach(c => { if (c.classification) cc[c.classification]=(cc[c.classification]||0)+1; if (c.valueCategory) vc[c.valueCategory]=(vc[c.valueCategory]||0)+1; });

      const totalCLV = withDays.reduce((s,c)=>s+(c.customerLifetimeValue||0),0);
      const avgCLV   = withDays.length ? totalCLV/withDays.length : 0;
      const totalRisky = (cc["At Risk"]||0)+(cc["Dormant"]||0);
      const atRiskPct = withDays.length>0 ? Math.round((totalRisky/withDays.length)*100) : 0;

      const mapClient = (c, fields) => { const r={}; fields.forEach(f=>r[f]=c[f]); return r; };
      const topClients = withDays.filter(c=>c.classification==="Top Value").sort((a,b)=>(b.customerLifetimeValue||0)-(a.customerLifetimeValue||0)).slice(0,50)
        .map(c=>({companyName:c.companyName,clv:c.customerLifetimeValue,classification:c.classification,valueCategory:c.valueCategory,daysSinceFollowUp:c.daysSinceFollowUp,lastActivity:c.lastFollowUpDate,progress:c.latestReview?.progress,supportPoints:c.supportPoints,supportTickets:c.totalSupportTickets,followUpCount:c.followUpCount,delivered:c.delivered,clientHealthScore:c.clientHealthScore}));
      const riskyClients = withDays.filter(c=>c.classification==="At Risk").sort((a,b)=>(b.daysSinceFollowUp||0)-(a.daysSinceFollowUp||0)).slice(0,50)
        .map(c=>({companyName:c.companyName,daysSinceFollowUp:c.daysSinceFollowUp,supportTickets:c.totalSupportTickets,progress:c.progress,supportPoints:c.supportPoints,classificationReason:c.classificationReason,delivered:c.delivered,clientHealthScore:c.clientHealthScore}));
      const dormantClients = withDays.filter(c=>c.classification==="Dormant").sort((a,b)=>(b.daysSinceFollowUp||0)-(a.daysSinceFollowUp||0)).slice(0,50)
        .map(c=>({companyName:c.companyName,daysSinceFollowUp:c.daysSinceFollowUp,lastFollowUp:c.lastFollowUpDate,classificationReason:c.classificationReason,supportTickets:c.totalSupportTickets,delivered:c.delivered,clientHealthScore:c.clientHealthScore}));
      const upsellClients = withDays.filter(c=>c.classification==="Upsell").sort((a,b)=>(b.customerLifetimeValue||0)-(a.customerLifetimeValue||0)).slice(0,50)
        .map(c=>({companyName:c.companyName,clv:c.customerLifetimeValue,classification:c.classification,progress:c.latestReview?.progress,supportTickets:c.totalSupportTickets,delivered:c.delivered,clientHealthScore:c.clientHealthScore,daysSinceFollowUp:c.daysSinceFollowUp}));
      const allClientsList = withDays.slice(0,100).map(c=>({companyName:c.companyName,dealValue:c.customerLifetimeValue,progress:c.progress,supportPoints:c.supportPoints,followUpCount:c.followUpCount,classification:c.classification,classificationReason:c.classificationReason,delivered:c.delivered,supportTickets:c.totalSupportTickets,clientHealthScore:c.clientHealthScore,daysSinceFollowUp:c.daysSinceFollowUp}));
      const recentReviews = await ClientReview.find().sort({ reviewedAt: -1 }).limit(5).populate("reviewedBy","firstName lastName").lean();

      const sixMonthsAgo = new Date(); sixMonthsAgo.setMonth(sixMonthsAgo.getMonth()-6);
      const revenueTrends = await Deal.aggregate([
        { 
          $match: { 
            stage: "Closed Won",
            $or: [
              { wonAt: { $gte: sixMonthsAgo } },
              { wonAt: null, createdAt: { $gte: sixMonthsAgo } },
              { wonAt: { $exists: false }, createdAt: { $gte: sixMonthsAgo } }
            ]
          } 
        },
        { 
          $addFields: { 
            winDate: { $ifNull: ["$wonAt", "$createdAt"] },
            numericValue: { $toDouble: { $reduce: { input: { $regexFindAll: { input: "$value", regex: "\\d+" } }, initialValue: "", in: { $concat: ["$$value", "$$this.match"] } } } } 
          } 
        },
        { $group: { _id: { year: { $year: "$winDate" }, month: { $month: "$winDate" } }, revenue: { $sum: "$numericValue" }, count: { $sum: 1 } } },
        { $sort: { "_id.year": 1, "_id.month": 1 } }, 
        { $limit: 12 }
      ]);
      const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      const now = new Date();
      const allMonths = Array.from({length:6},(_,i)=>{ const d=new Date(now.getFullYear(),now.getMonth()-5+i,1); const ms=`${months[d.getMonth()]} ${d.getFullYear()}`; const ex=revenueTrends.find(t=>t._id.year===d.getFullYear()&&t._id.month===d.getMonth()+1); return ex?{month:ms,revenue:ex.revenue||0,count:ex.count||0}:{month:ms,revenue:0,count:0}; });

      res.json({ success:true, data:{ summary:{ totalClients:withDays.length, totalCLV, avgCLV, clientsAtRiskPercent:atRiskPct, upsellCount:cc["Upsell"]||0, topValueCount:cc["Top Value"]||0, dormantCount:cc["Dormant"]||0, atRiskCount:cc["At Risk"]||0 }, valueCategories:vc, classificationDistribution:cc, topClients, riskyClients, dormantClients, upsellClients, allClientsList, recentReviews, revenueTrends:allMonths, pricingRiskAlerts:[] } });
    } catch (error) {
      console.error("Dashboard error:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  getClientCLV: async (req, res) => {
    try {
      const { ClientLTV, Deal, SupportTicket, Renewal, ClientReview } = getLTVModels(req);
      const decoded = decodeURIComponent(req.params.companyName);
      let client = await ClientLTV.findOne({ companyName: decoded }).lean();
      if (!client) {
        const deals = await Deal.find({ companyName: decoded, stage:"Closed Won" }).populate("assignedTo","firstName lastName").sort({ wonAt:-1, createdAt:-1 }).lean();
        if (!deals.length) return res.status(404).json({ success:false, message:"Client not found" });
        return res.json({ success:true, data:{ client:{ companyName:decoded, totalRevenue:0, daysSinceFollowUp:0, supportPoints:0 }, deals, tickets:[], renewals:[], reviews:[], pricingRisk:null, supportAnalysis:{ totalTickets:0, openTickets:0, lastSupportDate:null, ticketsPerMonth:0, avgResolutionDays:0, supportToRevenueRatio:0, supportPoints:0 } } });
      }
      const dynamicDays = client.lastFollowUpDate ? calcDaysSince(client.lastFollowUpDate) : 365;
      const clientWithDays = { ...client, daysSinceFollowUp: dynamicDays };
      const activeDeal = client.companyId ? await Deal.findOne({ _id: client.companyId, stage:"Closed Won" }).lean() : null;
      if (!activeDeal) return res.json({ success:true, data:{ client:clientWithDays, deals:[], tickets:[], renewals:[], reviews:[], pricingRisk:null, supportAnalysis:{ totalTickets:0, openTickets:0, lastSupportDate:null, ticketsPerMonth:0, avgResolutionDays:0, supportToRevenueRatio:0, supportPoints:client.supportPoints||0 } } });

      const [deals, tickets, renewals, reviews, pricingRisk] = await Promise.all([
        Deal.find({ companyName:decoded, stage:"Closed Won" }).populate("assignedTo","firstName lastName").sort({ wonAt:-1, createdAt:-1 }).lean(),
        client.companyId ? SupportTicket.find({ companyId: client.companyId }).sort({ openedAt:-1 }).lean() : [],
        Renewal.find({ companyName: decoded }).sort({ renewalDate:-1 }).lean(),
        client.companyId ? ClientReview.find({ companyId: client.companyId }).sort({ reviewedAt:-1 }).lean() : [],
        client.companyId ? PricingRisk.findOne({ companyId: client.companyId, status:"Active" }).lean() : null,
      ]);

      const totalTickets = tickets.length; const openTickets = tickets.filter(t=>t.status==="Open").length;
      const lastSupportDate = totalTickets ? tickets[0].openedAt : null;
      const sixMonthsAgo = new Date(); sixMonthsAgo.setMonth(sixMonthsAgo.getMonth()-6);
      const ticketsPerMonth = tickets.filter(t=>new Date(t.openedAt)>=sixMonthsAgo).length/6;
      const closed = tickets.filter(t=>t.status==="Closed"&&t.resolutionTimeHours);
      const avgResolutionDays = closed.length>0 ? (closed.reduce((s,t)=>s+(t.resolutionTimeHours||0),0)/24/closed.length) : 0;
      const supportToRevenueRatio = client.totalRevenue>0 ? (totalTickets/client.totalRevenue)*1000000 : 0;

      res.json({ success:true, data:{ client:clientWithDays, deals, tickets, renewals, reviews, pricingRisk, supportAnalysis:{ totalTickets, openTickets, lastSupportDate, ticketsPerMonth:ticketsPerMonth.toFixed(1), avgResolutionDays:avgResolutionDays.toFixed(1), supportToRevenueRatio:supportToRevenueRatio.toFixed(2), supportPoints:client.supportPoints||0 } } });
    } catch (error) {
      console.error("Get client error:", error);
      res.status(500).json({ success:false, message:error.message });
    }
  },

  calculateAllCLV: async (req, res) => {
    try {
      const models = getLTVModels(req);
      const { ClientReview } = models;
      const reviews = await ClientReview.find().lean();
      if (!reviews.length) return res.json({ success:true, count:0, message:"No reviews found" });
      res.json({ success:true, count:reviews.length, message:`Started processing ${reviews.length} clients in background.` });
      const BATCH_SIZE = 3; let processed = 0; let errors = 0;
      for (let i = 0; i < reviews.length; i += BATCH_SIZE) {
        for (const review of reviews.slice(i, i+BATCH_SIZE)) {
          try { await calculateMetricsFromReview(review.companyId, review.companyName, review, models); processed++; }
          catch (err) { errors++; console.error(`Error for ${review.companyName}:`, err.message); }
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      console.log(`calculateAllCLV complete: ${processed} ok, ${errors} errors`);
    } catch (error) { console.error("calculateAllCLV error:", error); }
  },

  createSupportTicket: async (req, res) => {
    try {
      const models = getLTVModels(req);
      const { SupportTicket } = models;
      const { companyName, companyId, subject, description, priority, category } = req.body;
      if (!companyName || !companyId || !subject || !description) return res.status(400).json({ success:false, message:"Missing required fields" });
      const userId = req.user?._id || req.user?.id;
      const date = new Date(); const year = date.getFullYear().toString().slice(-2); const month = (date.getMonth()+1).toString().padStart(2,"0");
      const count = await SupportTicket.countDocuments();
      const ticketNumber = `TKT-${year}${month}-${(count+1).toString().padStart(4,"0")}`;
      const ticket = new SupportTicket({ ticketNumber, companyName, companyId, subject, description, priority:priority||"Medium", category:category||"General", openedAt:new Date(), createdBy:userId });
      await ticket.save();
      recalculateMetricsFromDeal(companyId, companyName, models).catch(err => console.error("Error refreshing metrics:", err));
      res.status(201).json({ success:true, data:ticket });
    } catch (error) {
      console.error("Create ticket error:", error);
      res.status(500).json({ success:false, message:error.message });
    }
  },

  createRenewal: async (req, res) => {
    try {
      const { Renewal } = getLTVModels(req);
      const { dealId, companyName, renewalDate, renewalValue, currency } = req.body;
      if (!dealId || !companyName || !renewalDate || !renewalValue) return res.status(400).json({ success:false, message:"Missing required fields" });
      const renewal = new Renewal({ dealId, companyName, renewalDate, renewalValue: parseFloat(String(renewalValue).replace(/[^0-9.-]+/g,""))||0, currency:currency||"INR", assignedTo:req.user?._id||req.user?.id });
      await renewal.save();
      res.status(201).json({ success:true, data:renewal });
    } catch (error) {
      console.error("Create renewal error:", error);
      res.status(500).json({ success:false, message:error.message });
    }
  },

  getPricingRisks: async (req, res) => {
    try {
      const risks = await PricingRisk.find({ status:"Active" }).sort({ detectedAt:-1 }).limit(50).lean();
      res.json({ success:true, data:risks });
    } catch (error) {
      console.error("Error in getPricingRisks:", error);
      res.status(500).json({ success:false, message:error.message });
    }
  },

  resolvePricingRisk: async (req, res) => {
    try {
      await PricingRisk.findByIdAndUpdate(req.params.id, { status:"Resolved", resolvedAt:new Date() });
      res.json({ success:true, message:"Risk resolved" });
    } catch (error) {
      console.error("Error in resolvePricingRisk:", error);
      res.status(500).json({ success:false, message:error.message });
    }
  },

  getPricingRecommendation: async (req, res) => {
    try {
      const { ClientLTV, ClientReview } = getLTVModels(req);
      const decoded = decodeURIComponent(req.params.companyName);
      const client = await ClientLTV.findOne({ companyName: decoded }).lean();
      if (!client) return res.status(200).json({ success:false, message:"Client not found in CLV system", data:null });
      const latestReview = await ClientReview.findOne({ companyId: client.companyId }).sort({ reviewedAt:-1 }).lean();
      const pricing = calcPricing({ progress:latestReview?.progress||client.progress||"Average", supportTickets:client.totalSupportTickets||0, clientHealthScore:latestReview?.clientHealthScore||client.clientHealthScore||50, delivered:client.delivered||false, totalRevenue:client.customerLifetimeValue||0 });
      res.json({ success:true, data:{ ...pricing, classification:client.classification } });
    } catch (error) {
      console.error("Error in getPricingRecommendation:", error);
      res.status(200).json({ success:false, message:error.message||"Error calculating pricing recommendation", data:null });
    }
  },
};
