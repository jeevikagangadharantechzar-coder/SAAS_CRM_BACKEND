import { getTenantModels } from "../models/tenant/index.js";
import DealLegacy from "../models/deals.model.js";
import LeadLegacy from "../models/leads.model.js";
import UserLegacy from "../models/user.model.js";
import InvoiceLegacy from "../models/invoice.model.js";
import ProposalLegacy from "../models/proposal.model.js";
import streakController from "./streak.controller.js";

const getModels = (req) =>
  req.tenantDB
    ? getTenantModels(req.tenantDB)
    : { Deal: DealLegacy, Lead: LeadLegacy, User: UserLegacy, Invoice: InvoiceLegacy, Proposal: ProposalLegacy, Task: null, Target: null, AiChat: null, Activity: null, ClientLTV: null };

async function saveChat(AiChat, userId, message, intent, response, resultCount = 0) {
  if (!AiChat) return;
  try {
    await AiChat.create({ userId, message, intent, response, resultCount });
  } catch (err) {
    console.error("Ai Chat save failed (non-fatal):", err.message);
  }
}

function getDateFilter(lower) {
  const now = new Date();

  // Extract explicit 4 digit year from the string (e.g. 2025, 2027)
  const yearMatch = lower.match(/\b(20\d{2})\b/);
  const explicitYear = yearMatch ? parseInt(yearMatch[1]) : now.getFullYear();

  if (lower.includes("today")) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    return { filter: { $gte: start, $lte: end }, label: " today" };
  }
  if (lower.includes("yesterday")) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59, 999);
    return { filter: { $gte: start, $lte: end }, label: " yesterday" };
  }
  if (lower.includes("this week")) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (6 - now.getDay()), 23, 59, 59, 999);
    return { filter: { $gte: start, $lte: end }, label: " this week" };
  }
  if (lower.includes("last week")) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay() - 7);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay() - 1, 23, 59, 59, 999);
    return { filter: { $gte: start, $lte: end }, label: " last week" };
  }
  if (lower.includes("this month")) {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    return { filter: { $gte: start, $lte: end }, label: " this month" };
  }
  if (lower.includes("last month")) {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    return { filter: { $gte: start, $lte: end }, label: " last month" };
  }

  // Parse "last X days/weeks/months/years"
  const textToNum = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const lastXMatch = lower.match(/last\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(day|days|week|weeks|month|months|year|years)/i);
  if (lastXMatch) {
    const numStr = lastXMatch[1].toLowerCase();
    const num = isNaN(parseInt(numStr)) ? (textToNum[numStr] || 1) : parseInt(numStr);
    const unit = lastXMatch[2].toLowerCase();

    let start = new Date(now);
    if (unit.startsWith("day")) {
      start.setDate(now.getDate() - num);
    } else if (unit.startsWith("week")) {
      start.setDate(now.getDate() - (num * 7));
    } else if (unit.startsWith("month")) {
      start.setMonth(now.getMonth() - num);
    } else if (unit.startsWith("year")) {
      start.setFullYear(now.getFullYear() - num);
    }

    start.setHours(0, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    return { filter: { $gte: start, $lte: end }, label: ` in the last ${num} ${unit}` };
  }

  // Parse custom dates like "july 8", "july 08", "8 july", "8th july", "july8"
  const dateRegex = /(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s*(\d{1,2})(?:st|nd|rd)?|(\d{1,2})(?:st|nd|rd|th)?\s*(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)/i;
  let match = lower.match(dateRegex);
  const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const shortMonthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

  if (match) {
    const monthStr = (match[1] || match[4]).toLowerCase();
    const dayNum = parseInt(match[2] || match[3]);
    let monthIndex = monthNames.indexOf(monthStr);
    if (monthIndex === -1) monthIndex = shortMonthNames.indexOf(monthStr);
    if (monthIndex !== -1 && dayNum >= 1 && dayNum <= 31) {
      const year = explicitYear;
      const start = new Date(year, monthIndex, dayNum, 0, 0, 0, 0);
      const end = new Date(year, monthIndex, dayNum, 23, 59, 59, 999);
      const label = ` on ${monthNames[monthIndex]} ${dayNum} ${year}`;
      return { filter: { $gte: start, $lte: end }, label };
    }
  }

  // Just a month name (e.g. "july" or "in july" or "on june")
  const monthRegex = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/i;
  match = lower.match(monthRegex);
  if (match) {
    const monthStr = match[1].toLowerCase();
    let monthIndex = monthNames.indexOf(monthStr);
    if (monthIndex === -1) monthIndex = shortMonthNames.indexOf(monthStr);
    if (monthIndex !== -1) {
      const year = explicitYear;
      const start = new Date(year, monthIndex, 1);
      const end = new Date(year, monthIndex + 1, 0, 23, 59, 59, 999);
      const label = ` in ${monthNames[monthIndex]} ${year}`;
      return { filter: { $gte: start, $lte: end }, label };
    }
  }

  // Just a year (e.g. "in 2025")
  if (yearMatch) {
    const year = explicitYear;
    const start = new Date(year, 0, 1);
    const end = new Date(year, 11, 31, 23, 59, 59, 999);
    const label = ` in ${year}`;
    return { filter: { $gte: start, $lte: end }, label };
  }

  return { filter: null, label: "" };
}

export default {
  processMessage: async (req, res) => {
    try {
      const payload = req.method === "GET" ? req.query : req.body;
      const { message } = payload;

      if (!message) {
        return res.status(400).json({ success: false, message: "Message required" });
      }

      const { Deal, Lead, User, AiChat, Invoice, Task, Target, Proposal, Activity, ClientLTV } = getModels(req);
      const userId = req.user._id;
      const roleName =
        typeof req.user.role === "object" ? req.user.role.name : req.user.role;
      const lower = message.toLowerCase().trim();

      let { filter: dateFilter, label: dateLabel } = getDateFilter(lower);

      const stopWords = [
        "what", "is", "the", "for", "who", "whom", "whose", "when", "where", "why", "which", "how", "handles", "of", "deal", "deals", "lead", "leads", "show", "find", "get", "search",
        "today", "yesterday", "this", "last", "month", "week", "year", "hot", "warm", "cold", "my", "me", "and", "a", "an", "to", "by", "from", "list", "name", "names",
        "on", "created", "registered", "added", "of", "about", "how", "many", "converted", "rejected", "junk", "pending", "unassigned", "open", "closed", "stage", "stages", "in", "to", "from",
        "assigned", "handles", "handled", "by", "of", "owner", "owns", "follow", "up", "scheduled", "schedule", "time", "date", "overall", "won", "lost", "qualification", "proposal", "negotiation", "invoice", "new", "contacted", "qualified",
        "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
        "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
        "am", "is", "are", "was", "were", "has", "have", "had", "do", "does", "did", "with", "can", "could", "would", "will", "shall", "should", "those", "these", "this", "that", "there", "here",
        "at", "it", "he", "she", "they", "we", "please", "kindly", "tell", "give", "want", "see", "look", "display", "bring", "pull", "up"
      ];

      const queryKeywords = [
        "pending", "completed", "active", "progress", "high", "priority", "urgent", "low", "medium", "task", "tasks", "todo", "jobs", "assignments", "plan", "plans", "schedule", "agenda",
        "unpaid", "paid", "partially", "invoice", "invoices", "bills", "billing", "target", "targets", "goals", "quotas", "deal", "deals", "opportunity", "opportunities", "lead", "leads", "prospects",
        "streak", "leaderboard", "proposal", "proposals", "top", "performer", "ranking", "best", "highest",
        "success", "draft", "sent", "rejection", "rejected", "accepted", "approved", "reply", "failed", "dropped",
        "revenue", "sales", "earnings", "total", "analysis", "analytics", "report", "income", "profit", "turnover",
        "attachment", "attachments", "document", "documents", "file", "files"
      ];

      const getSearchTerms = (lower) => {
        return lower.split(/\s+/).filter(w =>
          w && w.length > 0 &&
          !stopWords.includes(w) &&
          !queryKeywords.includes(w) &&
          !(dateFilter && !isNaN(w))
        );
      };

      // --- 1. GREETINGS ---
      if (lower.match(/^(hi|hello|hey|greetings|good morning|good afternoon|good evening|sup|howdy|how are you|how are u|what's up|whats up|yo)\b/i) && lower.length < 40) {
        const responseMsg = "Hello, I am Ziya. How can I assist you today?";
        await saveChat(AiChat, userId, message, "greeting", responseMsg, 0);
        return res.json({ success: true, intent: "greeting", message: responseMsg, data: [] });
      }

      // --- 2. CAPABILITIES / HELP ---
      if (
        lower.includes("what can you do") ||
        lower.includes("what is your use") ||
        lower.includes("what are your capabilities") ||
        lower.includes("what do you do") ||
        lower.includes("who are you") ||
        lower.includes("uses") ||
        lower.includes("commands") ||
        lower.includes("how to use") ||
        lower === "help"
      ) {
        const responseMsg = "Hello! I am Ziya, your CRM AI Assistant. I'm here to help you manage your CRM data. For best results, you can ask me things like: 'Show my pending tasks', 'Find unpaid invoices', 'List my active targets', or 'Show my deals'.";
        await saveChat(AiChat, userId, message, "capabilities", responseMsg, 0);
        return res.json({ success: true, intent: "capabilities", message: responseMsg, data: [] });
      }

      // --- 3. PROPOSALS ---
      if (Proposal && (lower.includes("proposal") || lower.includes("proposals")) && !lower.includes("deal") && !lower.includes("deals")) {
        const searchTerms = getSearchTerms(lower);
        let matchingDealIds = [];
        let matchingUserIds = [];
        let firstMatchedTerm = "";

        if (searchTerms.length > 0) {
          firstMatchedTerm = searchTerms[0];
          const matchingDeals = await Deal.find({ dealName: { $regex: `^${firstMatchedTerm}`, $options: "i" } }).select("_id");
          matchingDealIds = matchingDeals.map(d => d._id);
          const matchingUsers = await User.find({
            $or: [
              { firstName: { $regex: `^${firstMatchedTerm}`, $options: "i" } },
              { lastName: { $regex: `^${firstMatchedTerm}`, $options: "i" } }
            ]
          }).select("_id");
          matchingUserIds = matchingUsers.map(u => u._id);
        }

        let query = {};
        if (searchTerms.length > 0) {
          query.$or = [
            { deal: { $in: matchingDealIds } },
            { createdBy: { $in: matchingUserIds } },
            { title: { $regex: firstMatchedTerm, $options: "i" } }
          ];
        }

        if (roleName !== "Admin") {
          query = query.$or ? { $and: [query, { createdBy: userId }] } : { createdBy: userId };
        }
        if (dateFilter) query.createdAt = dateFilter;

        let statusFilter = null;
        if (lower.includes("success") || lower.includes("accepted") || lower.includes("approved")) statusFilter = "Success";
        else if (lower.includes("sent")) statusFilter = "Sent";
        else if (lower.includes("draft")) statusFilter = "Draft";
        else if (lower.includes("no reply")) statusFilter = "No Reply";
        else if (lower.includes("rejection") || lower.includes("rejected")) statusFilter = "Rejection";

        if (statusFilter) {
          if (query.$and) query.$and.push({ status: statusFilter });
          else query.status = statusFilter;
        }

        const proposals = await Proposal.find(query).populate("createdBy", "firstName lastName").sort({ createdAt: -1 });
        const responseMsg = statusFilter
          ? `You have ${proposals.length} ${statusFilter.toLowerCase()} proposals${dateLabel}.`
          : `You have ${proposals.length} proposals${dateLabel}.`;

        await saveChat(AiChat, userId, message, "proposals-list", responseMsg, proposals.length);
        return res.json({ success: true, intent: "proposals-list", message: responseMsg, count: proposals.length, data: proposals.map(formatProposal) });
      }

      // --- 4. ANALYSIS ---
      if (lower.includes("analysis") || lower.includes("analytics") || lower.includes("report") || lower.includes("reason")) {
        let query = {};
        if (roleName !== "Admin") query.assignedTo = userId;
        if (dateFilter) query.createdAt = dateFilter;

        let responseMsg = "";
        let intentName = "analysis";
        let returnData = [];

        const isLoss = lower.includes("loss") || lower.includes("lost") || lower.includes("rejection") || lower.includes("failed") || lower.includes("dropped") || lower.includes("cancelled") || lower.includes("abandoned");
        const isWon = lower.includes("won") || lower.includes("win") || lower.includes("success") || lower.includes("achieved") || lower.includes("secured") || lower.includes("bagged");
        
        if (isLoss || (lower.includes("reason") && !isWon)) {
          query.stage = { $in: ["Closed Lost", "Rejected"] };

          const reasonMatch = lower.match(/(?:reason is|reason was|reason for|reason by|reason|because of|due to|caused by|account of|result of|why|explanation for)\s+([a-z0-9\s]+?)(?:\s+(?:in|last|this|today|yesterday|week|month|year)|$)/i);
          let reasonString = null;
          if (reasonMatch && reasonMatch[1]) {
            let extracted = reasonMatch[1].trim();
            // Clean up filler words that might get accidentally captured
            extracted = extracted.replace(/deals?\s+lost/gi, "").trim();
            
            const ignoreList = ["for deals lost", "deals lost", "for", "deals", "all", "dor deal lost", "deal lost", "dor", "by"];
            
            if (extracted.length > 0 && !ignoreList.includes(extracted.toLowerCase())) {
              reasonString = extracted;
              query.lossReason = { $regex: new RegExp(reasonString, 'i') };
            }
          }

          const lostDeals = await Deal.find(query).populate("assignedTo", "firstName lastName email").sort({ createdAt: -1 });
          const totalLost = lostDeals.reduce((sum, d) => sum + (Number(d.value) || 0), 0);

          if (reasonString) {
            responseMsg = `You have ${lostDeals.length} lost/rejected deals${dateLabel} for reason "${reasonString}" totaling ${totalLost.toLocaleString()}. For a deep dive into loss reasons, please visit the Loss Analysis dashboard.`;
          } else {
            responseMsg = `You have ${lostDeals.length} lost/rejected deals${dateLabel} totaling ${totalLost.toLocaleString()}. For a deep dive into loss reasons, please visit the Loss Analysis dashboard.`;
          }
          intentName = "loss-analysis";
          returnData = lostDeals;
        } else if (lower.includes("won") || lower.includes("win") || lower.includes("success")) {
          query.stage = "Closed Won";
          const wonDeals = await Deal.find(query).populate("assignedTo", "firstName lastName email").sort({ createdAt: -1 });
          const totalWon = wonDeals.reduce((sum, d) => sum + (Number(d.value) || 0), 0);
          responseMsg = `You have ${wonDeals.length} won deals${dateLabel} totaling ${totalWon.toLocaleString()}. For detailed win rates and metrics, please visit the Deal Analysis dashboard.`;
          intentName = "won-analysis";
          returnData = wonDeals;
        } else if (lower.includes("deal") || lower.includes("pipeline") || lower.includes("opportunity") || lower.includes("opportunities") || lower.includes("funnel")) {
          const allDeals = await Deal.find(query).populate("assignedTo", "firstName lastName email").sort({ createdAt: -1 });
          const openDeals = allDeals.filter(d => !["Closed Won", "Closed Lost", "Rejected"].includes(d.stage));
          const totalOpenValue = openDeals.reduce((sum, d) => sum + (Number(d.value) || 0), 0);
          responseMsg = `You have ${allDeals.length} total deals${dateLabel} (${openDeals.length} open deals worth ${totalOpenValue.toLocaleString()}). For full pipeline intelligence, please visit the Deal Analysis dashboard.`;
          intentName = "deal-analysis";
          returnData = allDeals;
        } else {
          responseMsg = "To view your CRM insights, please visit the Deal Analysis or Loss Analysis dashboards.";
        }

        await saveChat(AiChat, userId, message, intentName, responseMsg, returnData.length);
        return res.json({ success: true, intent: intentName, message: responseMsg, count: returnData.length, data: returnData.map(formatDeal) });
      }

      // --- 5. REVENUE / SALES ---
      if (lower.includes("revenue") || lower.includes("earnings") || lower.includes("total sales") || lower.includes("income") || lower.includes("profit") || lower.includes("turnover") || lower.includes("money made")) {
        if (Invoice) {
          const searchTerms = getSearchTerms(lower);
          let matchingUserIds = [];
          if (searchTerms.length > 0) {
            for (const term of searchTerms) {
              const matchingUsers = await User.find({
                $or: [
                  { firstName: { $regex: `^${term}`, $options: "i" } },
                  { lastName: { $regex: `^${term}`, $options: "i" } }
                ]
              }).select("_id");
              if (matchingUsers.length > 0) {
                matchingUserIds = matchingUsers.map(u => u._id);
                break;
              }
            }
          }

          let query = { status: { $in: ["paid", "partially_paid"] } };
          if (matchingUserIds.length > 0) {
            query.assignTo = { $in: matchingUserIds };
          }

          if (roleName !== "Admin") {
            if (query.assignTo) {
              query.$and = [{ assignTo: query.assignTo }, { assignTo: userId }];
              delete query.assignTo;
            } else {
              query.assignTo = userId;
            }
          }
          if (dateFilter) query.createdAt = dateFilter;
          const invoices = await Invoice.find(query).populate("assignTo", "firstName lastName").sort({ createdAt: -1 });
          const totalRevenue = invoices.reduce((sum, inv) => sum + (Number(inv.total) || 0), 0);

          const currency = invoices.length > 0 && invoices[0].currency ? invoices[0].currency : "USD";
          const responseMsg = `Your total revenue from Paid and Partially Paid Invoices${dateLabel} is ${totalRevenue.toLocaleString()} ${currency} (from ${invoices.length} invoices).`;

          await saveChat(AiChat, userId, message, "revenue", responseMsg, invoices.length);
          return res.json({ success: true, intent: "revenue", message: responseMsg, count: invoices.length, data: invoices.map(formatInvoice) });
        }
      }

      // --- 6. CLIENT CLASSIFICATION (CLV) ---
      if (lower.includes("upsell") || lower.includes("upgrade") || lower.includes("cross-sell") || lower.includes("top value") || lower.includes("vip") || lower.includes("best client") || lower.includes("at risk") || lower.includes("churn") || lower.includes("danger") || lower.includes("dormant") || lower.includes("inactive") || lower.includes("ghosted")) {
        let classification = null;
        let responseMsg = "";
        if (lower.includes("upsell") || lower.includes("upgrade") || lower.includes("cross-sell")) classification = "Upsell";
        else if (lower.includes("top value") || lower.includes("vip") || lower.includes("best client")) classification = "Top Value";
        else if (lower.includes("at risk") || lower.includes("churn") || lower.includes("danger")) classification = "At Risk";
        else if (lower.includes("dormant") || lower.includes("inactive") || lower.includes("ghosted")) classification = "Dormant";

        if (classification && ClientLTV) {
          const clients = await ClientLTV.find({ classification }).sort({ totalRevenue: -1 });
          const totalRevenue = clients.reduce((sum, c) => sum + (Number(c.totalRevenue) || 0), 0);

          responseMsg = `You have ${clients.length} ${classification} clients totaling ${totalRevenue.toLocaleString()}.`;
          await saveChat(AiChat, userId, message, "client-classification", responseMsg, clients.length);
          return res.json({ success: true, intent: "client-classification", message: responseMsg, count: clients.length, data: clients.map(formatClientLTV) });
        }
      }

      // --- 6. LEADERBOARD & PERFORMANCE ---
      if (lower.includes("leaderboard") || lower.includes("top performer") || lower.includes("top sales") || lower.includes("best") || lower.includes("highest") || lower.includes("number one") || lower.includes("ranking") || lower.includes("mvp")) {
        // Mock req/res to call streakController.getLeaderboard
        const mockReq = {
          user: req.user,
          tenantDB: req.tenantDB,
          query: {}
        };
        // Date filters for leaderboard are usually passed as startDate/endDate
        if (dateFilter && dateFilter.$gte) {
          mockReq.query.startDate = dateFilter.$gte;
          mockReq.query.endDate = dateFilter.$lte || new Date();
        } else if (lower.includes("all time") || lower.includes("overall")) {
          mockReq.query.allTime = true;
          dateLabel = " of all time";
        }

        const leaderboardData = await new Promise((resolve) => {
          const mockRes = {
            status: () => mockRes,
            json: (data) => resolve(data)
          };
          streakController.getLeaderboard(mockReq, mockRes).catch(err => resolve({ success: false, error: err.message }));
        });

        if (leaderboardData && leaderboardData.success && leaderboardData.data && leaderboardData.data.length > 0) {
          let rows = leaderboardData.data;
          // Resort by converted leads to find the true top performer for the chatbot
          rows = [...rows].sort((a, b) => b.convertedLeads !== a.convertedLeads ? b.convertedLeads - a.convertedLeads : b.conversionRate - a.conversionRate);
          const top = rows[0];
          const responseMsg = `The top performer${dateLabel} is ${top.name} with a ${top.conversionDisplay} conversion rate (${top.convertedLeads} deals won out of ${top.totalLeads} leads).`;

          const formattedUser = {
            _id: top.id,
            type: "user",
            name: top.name,
            email: top.email,
            role: top.role,
            value: `${top.conversionDisplay} Conversion, ${top.convertedLeads} Deals Won`,
            performanceScore: top.performanceScore,
            status: top.status,
            statusColor: top.statusColor
          };

          await saveChat(AiChat, userId, message, "leaderboard", responseMsg, 1);
          return res.json({ success: true, intent: "leaderboard", message: responseMsg, data: [formattedUser] });
        } else {
          const responseMsg = `There are no closed won deals${dateLabel} to determine a top performer.`;
          await saveChat(AiChat, userId, message, "leaderboard", responseMsg, 0);
          return res.json({ success: true, intent: "leaderboard", message: responseMsg, data: [] });
        }
      }

      // --- 5. INVOICES ---
      if (Invoice && (lower.includes("invoice") || lower.includes("invoices") || lower.includes("bills") || lower.includes("billing") || lower.includes("payments") || lower.includes("receipts")) && !lower.includes("deal") && !lower.includes("deals")) {
        const searchTerms = getSearchTerms(lower);

        // If there's a search term (like a deal name "jack" or invoice number "TZI-59798" or salesperson "mary")
        let matchingDealIds = [];
        let matchingUserIds = [];
        let firstMatchedTerm = "";
        let matchingUsers = [];
        let matchingDeals = [];

        if (searchTerms.length > 0) {
          firstMatchedTerm = searchTerms[0];
          // Find matching deals
          matchingDeals = await Deal.find({ dealName: { $regex: `^${firstMatchedTerm}`, $options: "i" } }).select("_id dealName");
          matchingDealIds = matchingDeals.map(d => d._id);

          // Find matching users
          matchingUsers = await User.find({
            $or: [
              { firstName: { $regex: `^${firstMatchedTerm}`, $options: "i" } },
              { lastName: { $regex: `^${firstMatchedTerm}`, $options: "i" } }
            ]
          }).select("_id firstName lastName");
          matchingUserIds = matchingUsers.map(u => u._id);
        }

        // If it's a specific single-invoice lookup (no status filters)
        if (searchTerms.length > 0 && !lower.includes("paid") && !lower.includes("unpaid") && !lower.includes("partially") && !lower.includes("balance") && !lower.includes("due")) {
          let query = {
            $or: [
              { invoicenumber: { $regex: firstMatchedTerm, $options: "i" } },
              { assignTo: { $in: matchingUserIds } },
              { "items.deal": { $in: matchingDealIds } },
              { note: { $regex: firstMatchedTerm, $options: "i" } },
              { billingAddress: { $regex: firstMatchedTerm, $options: "i" } }
            ]
          };

          if (roleName !== "Admin") {
            query = { $and: [query, { assignTo: userId }] };
          }
          if (dateFilter) query.createdAt = dateFilter;

          const invoices = await Invoice.find(query).populate("assignTo", "firstName lastName email").sort({ createdAt: -1 });

          let responseMsg = "";
          if (invoices.length > 0) {
            const firstInv = invoices[0];
            const handler = firstInv.assignTo ? `${firstInv.assignTo.firstName} ${firstInv.assignTo.lastName}` : "Unassigned";
            if (lower.includes("due date") || lower.includes("due")) {
              responseMsg = `The due date for invoice ${firstInv.invoicenumber} is ${new Date(firstInv.dueDate).toLocaleDateString()}.`;
            } else if (lower.includes("who handles") || lower.includes("handles") || lower.includes("handler") || lower.includes("assigned")) {
              responseMsg = `Invoice ${firstInv.invoicenumber} is handled by ${handler}.`;
            } else {
              responseMsg = `Found invoice ${firstInv.invoicenumber} (status: ${firstInv.status}).`;
            }
          } else {
            responseMsg = `No invoice found matching "${firstMatchedTerm}"${dateLabel}.`;
          }

          await saveChat(AiChat, userId, message, "invoice-search", responseMsg, invoices.length);
          return res.json({ success: true, intent: "invoice-search", message: responseMsg, count: invoices.length, data: invoices.map(formatInvoice) });
        }

        // Filter by status, assigned, and search terms
        let statusFilter = null;
        let intentName = "invoices-list";
        let statusLabel = "";

        if (lower.includes("paid") && !lower.includes("unpaid") && !lower.includes("partially")) {
          statusFilter = "paid";
          intentName = "invoices-paid";
          statusLabel = "paid ";
        } else if (lower.includes("unpaid")) {
          statusFilter = "unpaid";
          intentName = "invoices-unpaid";
          statusLabel = "unpaid ";
        } else if (lower.includes("partially")) {
          statusFilter = "partially_paid";
          intentName = "invoices-partially-paid";
          statusLabel = "partially paid ";
        }

        let query = {};
        if (statusFilter) query.status = statusFilter;

        // Scope to salesperson if Admin queries salesperson name, or if not Admin
        if (roleName !== "Admin" || lower.includes("my")) {
          query.assignTo = userId;
          intentName += "-mine";
        } else if (matchingUserIds.length > 0) {
          query.assignTo = { $in: matchingUserIds };
        }

        // Restrict to deal matches if deal name searched
        if (matchingDealIds.length > 0) {
          query["items.deal"] = { $in: matchingDealIds };
        }

        if (dateFilter) query.createdAt = dateFilter;

        const invoices = await Invoice.find(query).populate("assignTo", "firstName lastName email").sort({ createdAt: -1 });

        let responseMsg = "";
        const isSelfQuery = matchingUserIds.length > 0 && matchingUserIds.some(id => String(id) === String(userId));
        if (matchingUsers.length > 0 && !isSelfQuery) {
          const names = matchingUsers.map(u => `${u.firstName} ${u.lastName}`).join(", ");
          responseMsg = `${names} has ${invoices.length} ${statusLabel}invoices${dateLabel}.`;
        } else if (matchingDeals.length > 0) {
          const names = matchingDeals.map(d => `deal "${d.dealName}"`).join(", ");
          responseMsg = `${names} has ${invoices.length} ${statusLabel}invoices${dateLabel}.`;
        } else {
          responseMsg = `You have ${invoices.length} ${statusLabel}invoices${dateLabel}.`;
        }

        await saveChat(AiChat, userId, message, intentName, responseMsg, invoices.length);
        return res.json({ success: true, intent: intentName, message: responseMsg, count: invoices.length, data: invoices.map(formatInvoice) });
      }

      // --- 4. TASKS ---
      if (Task && (lower.includes("task") || lower.includes("tasks") || lower.includes("todo") || lower.includes("to-do") || lower.includes("jobs") || lower.includes("assignments") || lower.includes("work") || lower.includes("plan") || lower.includes("schedule") || lower.includes("agenda"))) {
        const searchTerms = getSearchTerms(lower);

        let matchingDeals = [];
        let matchingLeads = [];
        let matchingUsers = [];
        let firstMatchedTerm = "";

        if (searchTerms.length > 0) {
          firstMatchedTerm = searchTerms[0];
          matchingDeals = await Deal.find({ dealName: { $regex: `^${firstMatchedTerm}`, $options: "i" } }).select("_id dealName");
          matchingLeads = await Lead.find({ leadName: { $regex: `^${firstMatchedTerm}`, $options: "i" } }).select("_id leadName");
          matchingUsers = await User.find({
            $or: [
              { firstName: { $regex: `^${firstMatchedTerm}`, $options: "i" } },
              { lastName: { $regex: `^${firstMatchedTerm}`, $options: "i" } }
            ]
          }).select("_id firstName lastName");
        }

        const matchingDealIds = matchingDeals.map(d => d._id);
        const matchingLeadIds = matchingLeads.map(l => l._id);
        const matchingUserIds = matchingUsers.map(u => u._id);

        // Search specific single task (no status filters)
        if (searchTerms.length > 0 && !lower.includes("pending") && !lower.includes("completed") && !lower.includes("priority") && !lower.includes("active") && !lower.includes("progress")) {
          let query = {
            $or: [
              { title: { $regex: firstMatchedTerm, $options: "i" } },
              { description: { $regex: firstMatchedTerm, $options: "i" } },
              { assignedTo: { $in: matchingUserIds } },
              { leadRef: { $in: matchingLeadIds } },
              { leadRefs: { $in: matchingLeadIds } },
              { dealRef: { $in: matchingDealIds } },
              { dealRefs: { $in: matchingDealIds } }
            ],
            archived: false
          };

          if (roleName !== "Admin") {
            query = { $and: [query, { assignedTo: userId }] };
          }
          if (dateFilter) query.createdAt = dateFilter;

          const tasks = await Task.find(query).populate("assignedTo", "firstName lastName email").sort({ createdAt: -1 });

          let responseMsg = "";
          if (tasks.length > 0) {
            const firstTask = tasks[0];
            const handler = firstTask.assignedTo ? `${firstTask.assignedTo.firstName} ${firstTask.assignedTo.lastName}` : "Unassigned";
            if (lower.includes("due date") || lower.includes("due")) {
              responseMsg = `The due date for task "${firstTask.title}" is ${new Date(firstTask.dueDate).toLocaleDateString()}.`;
            } else if (lower.includes("who handles") || lower.includes("handles") || lower.includes("handler") || lower.includes("assigned")) {
              responseMsg = `Task "${firstTask.title}" is assigned to ${handler}.`;
            } else {
              responseMsg = `Found task "${firstTask.title}" (status: ${firstTask.status}).`;
            }
          } else {
            responseMsg = `No task found matching "${firstMatchedTerm}"${dateLabel}.`;
          }

          await saveChat(AiChat, userId, message, "task-search", responseMsg, tasks.length);
          return res.json({ success: true, intent: "task-search", message: responseMsg, count: tasks.length, data: tasks.map(formatTask) });
        }

        // Filter by status or priority, salesperson, and deal/lead
        let query = { archived: false };
        let intentName = "tasks-list";
        let typeLabel = "";

        if (lower.includes("completed")) {
          query.status = "Completed";
          intentName = "tasks-completed";
          typeLabel = "completed ";
        } else if (lower.includes("pending") || lower.includes("active") || lower.includes("in progress")) {
          query.status = { $in: ["New", "Pending", "In Progress", "In Hold"] };
          intentName = "tasks-pending";
          typeLabel = "pending ";
        } else if (lower.includes("high priority") || lower.includes("urgent")) {
          query.priority = { $in: ["High", "Urgent"] };
          intentName = "tasks-high-priority";
          typeLabel = "high priority ";
        }

        if (matchingUserIds.length > 0 && !lower.includes("my")) {
          let userIds = matchingUserIds;
          if (roleName !== "Admin") {
            userIds = userIds.filter(id => id.toString() === userId.toString());
          }
          if (userIds.length > 0) {
            query.assignedTo = { $in: userIds };
          } else {
            const responseMsg = `You do not have permission to view tasks assigned to other users.`;
            await saveChat(AiChat, userId, message, "tasks-by-salesperson", responseMsg, 0);
            return res.json({ success: true, intent: "tasks-by-salesperson", message: responseMsg, count: 0, data: [] });
          }
        } else if (roleName !== "Admin" || lower.includes("my")) {
          query.assignedTo = userId;
          intentName += "-mine";
        }

        if (matchingDealIds.length > 0 || matchingLeadIds.length > 0) {
          query.$or = [
            { leadRef: { $in: matchingLeadIds } },
            { leadRefs: { $in: matchingLeadIds } },
            { dealRef: { $in: matchingDealIds } },
            { dealRefs: { $in: matchingDealIds } }
          ];
        }

        if (dateFilter) query.createdAt = dateFilter;

        const tasks = await Task.find(query).populate("assignedTo", "firstName lastName email").sort({ createdAt: -1 });

        let responseMsg = "";
        const isSelfQuery = matchingUserIds.length > 0 && matchingUserIds.some(id => String(id) === String(userId));
        if (matchingUsers.length > 0 && !isSelfQuery) {
          const names = matchingUsers.map(u => `${u.firstName} ${u.lastName}`).join(", ");
          responseMsg = `${names} has ${tasks.length} ${typeLabel}tasks${dateLabel}.`;
        } else if (matchingDeals.length > 0 || matchingLeads.length > 0) {
          const dealNames = matchingDeals.map(d => `deal "${d.dealName}"`);
          const leadNames = matchingLeads.map(l => `lead "${l.leadName}"`);
          const entityNames = [...dealNames, ...leadNames].join(", ");
          responseMsg = `${entityNames} has ${tasks.length} ${typeLabel}tasks${dateLabel}.`;
        } else {
          responseMsg = `You have ${tasks.length} ${typeLabel}tasks${dateLabel}.`;
        }

        await saveChat(AiChat, userId, message, intentName, responseMsg, tasks.length);
        return res.json({ success: true, intent: intentName, message: responseMsg, count: tasks.length, data: tasks.map(formatTask) });
      }

      // --- 5. TARGETS ---
      if (Target && (lower.includes("target") || lower.includes("targets") || lower.includes("progress") || lower.includes("goals") || lower.includes("quotas") || lower.includes("objectives") || lower.includes("kpi"))) {
        const searchTerms = getSearchTerms(lower);

        let matchingUsers = [];
        if (searchTerms.length > 0) {
          const firstMatchedTerm = searchTerms[0];
          matchingUsers = await User.find({
            $or: [
              { firstName: { $regex: `^${firstMatchedTerm}`, $options: "i" } },
              { lastName: { $regex: `^${firstMatchedTerm}`, $options: "i" } }
            ]
          }).select("_id firstName lastName");
        }
        const matchingUserIds = matchingUsers.map(u => u._id);

        let query = {};
        let intentName = "targets-list";
        let typeLabel = "";

        if (lower.includes("completed")) {
          query.status = "Completed";
          intentName = "targets-completed";
          typeLabel = "completed ";
        } else if (lower.includes("active") || lower.includes("in progress") || lower.includes("pending")) {
          query.status = { $in: ["New", "In Progress", "In Hold"] };
          intentName = "targets-active";
          typeLabel = "pending ";
        }

        if (matchingUserIds.length > 0 && !lower.includes("my")) {
          let userIds = matchingUserIds;
          if (roleName !== "Admin") {
            userIds = userIds.filter(id => id.toString() === userId.toString());
          }
          if (userIds.length > 0) {
            query.salesPerson = { $in: userIds };
          } else {
            const responseMsg = `You do not have permission to view targets assigned to other users.`;
            await saveChat(AiChat, userId, message, "targets-by-salesperson", responseMsg, 0);
            return res.json({ success: true, intent: "targets-by-salesperson", message: responseMsg, count: 0, data: [] });
          }
        } else if (roleName !== "Admin" || lower.includes("my")) {
          query.salesPerson = userId;
          intentName += "-mine";
        }
        if (dateFilter) query.createdAt = dateFilter;

        const targets = await Target.find(query).populate("salesPerson", "firstName lastName email").sort({ createdAt: -1 });

        const targetsWithActuals = await Promise.all(targets.map(async (t) => {
          const actuals = await computeTargetActuals(t, { Lead, Deal });
          return { ...t.toObject(), actuals };
        }));

        let responseMsg = "";
        const isSelfQuery = matchingUserIds.length > 0 && matchingUserIds.some(id => String(id) === String(userId));
        if (matchingUsers.length > 0 && !isSelfQuery) {
          const names = matchingUsers.map(u => `${u.firstName} ${u.lastName}`).join(", ");
          responseMsg = `${names} has ${targets.length} ${typeLabel}targets${dateLabel}.`;
        } else {
          responseMsg = `You have ${targets.length} ${typeLabel}targets${dateLabel}.`;
        }

        await saveChat(AiChat, userId, message, intentName, responseMsg, targets.length);
        return res.json({ success: true, intent: intentName, message: responseMsg, count: targets.length, data: targetsWithActuals.map(formatTarget) });
      }

      // --- 6. USERS / PROFILES ---
      if (lower.includes("profile") || lower.includes("who am i") || lower.includes("user") || lower.includes("users") || lower.includes("my account") || lower.includes("my details") || lower.includes("employees") || lower.includes("staff") || lower.includes("team members")) {
        if (lower.includes("who am i") || lower.includes("my profile")) {
          const user = await User.findById(userId).populate("role");
          const userRole = user.role?.name || "User";
          const responseMsg = `You are logged in as ${user.firstName} ${user.lastName} (${userRole}).`;
          await saveChat(AiChat, userId, message, "user-profile", responseMsg, 1);
          return res.json({ success: true, intent: "user-profile", message: responseMsg, count: 1, data: [formatUser(user)] });
        }

        if (roleName === "Admin" && (lower.includes("all users") || lower.includes("show users") || lower.includes("active users") || lower.includes("registered users"))) {
          let query = {};
          if (lower.includes("active")) query.isActive = true;
          if (dateFilter) query.createdAt = dateFilter;
          const users = await User.find(query).populate("role").sort({ createdAt: -1 });
          const responseMsg = `There are ${users.length} users registered${dateLabel}.`;
          await saveChat(AiChat, userId, message, "users-list", responseMsg, users.length);
          return res.json({ success: true, intent: "users-list", message: responseMsg, count: users.length, data: users.map(formatUser) });
        }
      }

      // --- DEALS ---
      if (lower.includes("deal") || lower.includes("deals") || lower.includes("dela") || lower.includes("delas") || lower.includes("opportunity") || lower.includes("opportunities") || lower.includes("funnel") || lower.includes("pipeline")) {
        const dealSearchTerms = getSearchTerms(lower);
        let matchingUsers = [];
        if (dealSearchTerms.length > 0) {
          const firstMatchedTerm = dealSearchTerms[0];
          matchingUsers = await User.find({
            $or: [
              { firstName: { $regex: `^${firstMatchedTerm}`, $options: "i" } },
              { lastName: { $regex: `^${firstMatchedTerm}`, $options: "i" } }
            ]
          }).select("_id firstName lastName email");
        }
        const matchingUserIds = matchingUsers.map(u => u._id);

        let specificDealMatch = false;
        if (/\bdeal/.test(lower) && !/\bdeals/.test(lower)) {
          const dealMatches = [...message.matchAll(/\bdeal\s*([A-Za-z0-9_-]+)/gi)];
          if (dealMatches.length > 0) {
            const invalidNames = ["score", "tasks", "task", "invoice", "invoices", "activity", "activities", "history", "notes", "proposal", "proposals", "attachment", "attachments", "document", "documents", "file", "files", "details", "info", "target", "targets", "meeting", "email", "follow", "status", "by", "for", "with", "of", "to", "in", "on", "at", "about", "called", "named", "reason", "lost", "why", "won", "rejected", "open", "closed", "qualification", "negotiation"];
            const validMatches = dealMatches.filter(m => !invalidNames.includes(m[1].toLowerCase()));
            if (validMatches.length > 0) specificDealMatch = true;
          }
        }

        const dealStages = [
          { key: "qualification", keys: ["qualification", "qualifictaion"], name: "Qualification" },
          { key: "proposal", keys: ["proposal", "proposals"], name: "Proposal Sent-Negotiation" },
          { key: "negotiation", keys: ["negotiation", "negotaition"], name: "Proposal Sent-Negotiation" },
          { key: "invoice_sent", keys: ["invoice sent", "invoices sent"], name: "Invoice Sent" },
          { key: "won", keys: ["won", "closed won"], name: "Closed Won" },
          { key: "lost", keys: ["lost", "closed lost"], name: "Closed Lost" },
          { key: "rejected", keys: ["rejected"], name: "Rejected" }
        ];

        const matchedStage = dealStages.find(s => s.keys.some(k => lower.includes(k)));
        if (matchedStage && !specificDealMatch) {
          let query = { stage: matchedStage.name };

          if (matchingUserIds.length > 0 && !lower.includes("my")) {
            let userIds = matchingUserIds;
            if (roleName !== "Admin") {
              userIds = userIds.filter(id => id.toString() === userId.toString());
            }
            if (userIds.length > 0) {
              query.assignedTo = { $in: userIds };
            } else {
              const responseMsg = `You do not have permission to view deals assigned to other users.`;
              await saveChat(AiChat, userId, message, `deals-${matchedStage.key}`, responseMsg, 0);
              return res.json({ success: true, intent: `deals-${matchedStage.key}`, message: responseMsg, count: 0, data: [] });
            }
          } else if (roleName !== "Admin") {
            query.assignedTo = userId;
          }

          if (dateFilter) {
            if (matchedStage.key === "won") query.wonAt = dateFilter;
            else if (matchedStage.key === "lost") query.lostDate = dateFilter;
            else query.createdAt = dateFilter;
          }
          const deals = await Deal.find(query).populate("assignedTo", "firstName lastName email").sort({ createdAt: -1 });
          let responseMsg = `You have ${deals.length} deals in ${matchedStage.name} stage${dateLabel}.`;
          if (matchingUserIds.length > 0 && !lower.includes("my")) {
            const salespersonNames = matchingUsers.map(sp => `${sp.firstName} ${sp.lastName}`).join(", ");
            responseMsg = `Found ${deals.length} deals in ${matchedStage.name} stage handled by ${salespersonNames}${dateLabel}.`;
          }
          await saveChat(AiChat, userId, message, `deals-${matchedStage.key}`, responseMsg, deals.length);
          return res.json({ success: true, intent: `deals-${matchedStage.key}`, message: responseMsg, count: deals.length, data: deals.map(formatDeal) });
        }

        if ((lower.includes("open deals") || lower.includes("deals open") || (lower.includes("open") && lower.includes("deal"))) && !specificDealMatch) {
          let query = { stage: { $nin: ["Closed Won", "Closed Lost"] } };

          if (matchingUserIds.length > 0 && !lower.includes("my")) {
            let userIds = matchingUserIds;
            if (roleName !== "Admin") {
              userIds = userIds.filter(id => id.toString() === userId.toString());
            }
            if (userIds.length > 0) {
              query.assignedTo = { $in: userIds };
            } else {
              const responseMsg = `You do not have permission to view deals assigned to other users.`;
              await saveChat(AiChat, userId, message, "deals-open", responseMsg, 0);
              return res.json({ success: true, intent: "deals-open", message: responseMsg, count: 0, data: [] });
            }
          } else if (roleName !== "Admin") {
            query.assignedTo = userId;
          }

          if (dateFilter) query.createdAt = dateFilter;
          const deals = await Deal.find(query).populate("assignedTo", "firstName lastName email").sort({ createdAt: -1 });
          let responseMsg = `You have ${deals.length} open deals${dateLabel}.`;
          if (matchingUserIds.length > 0 && !lower.includes("my")) {
            const salespersonNames = matchingUsers.map(sp => `${sp.firstName} ${sp.lastName}`).join(", ");
            responseMsg = `Found ${deals.length} open deals handled by ${salespersonNames}${dateLabel}.`;
          }
          await saveChat(AiChat, userId, message, "deals-open", responseMsg, deals.length);
          return res.json({ success: true, intent: "deals-open", message: responseMsg, count: deals.length, data: deals.map(formatDeal) });
        }

        if ((lower.includes("my deals") || lower === "my deals") && !specificDealMatch) {
          let query = { assignedTo: userId };
          if (dateFilter) query.createdAt = dateFilter;
          const deals = await Deal.find(query).populate("assignedTo", "firstName lastName email").sort({ createdAt: -1 });
          const responseMsg = `You have ${deals.length} deal${deals.length !== 1 ? "s" : ""} assigned to you${dateLabel}.`;
          await saveChat(AiChat, userId, message, "my-deals", responseMsg, deals.length);
          return res.json({ success: true, intent: "my-deals", message: responseMsg, count: deals.length, data: deals.map(formatDeal) });
        }

        if (/\bdeal/.test(lower) && !/\bdeals/.test(lower)) {
          // Extract the deal name using regex (e.g. "deal score for deal jack" -> "jack")
          const dealMatches = [...message.matchAll(/\bdeal\s*([A-Za-z0-9_-]+)/gi)];
          let searchTerm = "";
          if (dealMatches.length > 0) {
            const invalidNames = ["score", "tasks", "task", "invoice", "invoices", "activity", "activities", "history", "notes", "proposal", "proposals", "attachment", "attachments", "details", "info", "target", "targets", "meeting", "email", "follow", "status", "by", "for", "with", "of", "to", "in", "on", "at", "about", "called", "named", "reason", "lost", "why", "won", "rejected", "open", "closed", "qualification", "negotiation"];
            const validMatches = dealMatches.filter(m => !invalidNames.includes(m[1].toLowerCase()));
            if (validMatches.length > 0) {
              searchTerm = validMatches[validMatches.length - 1][1].trim();
            }
          }
          if (!searchTerm) {
            // Remove stop words and action words
            const cleanTerms = lower.replace(/deal|show|get|find|search|for|about|named|called|balance|due|unpaid|paid|invoice|invoices/gi, "").trim().split(/\s+/).filter(Boolean);
            searchTerm = cleanTerms.length > 0 ? cleanTerms[cleanTerms.length - 1] : "";
          }

          if (searchTerm && stopWords.includes(searchTerm.toLowerCase())) {
            searchTerm = "";
          }

          if (searchTerm.length > 0) {
            let query = { dealName: { $regex: searchTerm, $options: "i" } };

            const hasSubQuery = lower.includes("task") || lower.includes("proposal") || lower.includes("invoice") || lower.includes("balance") || lower.includes("due") || lower.includes("meeting") || lower.includes("email") || lower.includes("follow") || lower.includes("history") || lower.includes("note") || lower.includes("attachment") || lower.includes("document") || lower.includes("file") || lower.includes("target") || lower.includes("score") || lower.includes("detail");

            let specificMatchedStage = dealStages.find(s => s.keys.some(k => lower.includes(k)));

            // Prevent entity keywords from acting as stage filters unless explicitly intended
            if (specificMatchedStage) {
              if (specificMatchedStage.name === "Proposal Sent-Negotiation" && lower.includes("proposal") && !lower.includes("stage") && !lower.includes("negotiation")) {
                specificMatchedStage = null;
              } else if (specificMatchedStage.name === "Invoice Sent" && lower.includes("invoice") && !lower.includes("stage") && !lower.includes("sent")) {
                specificMatchedStage = null;
              }
            }

            if (specificMatchedStage) query.stage = specificMatchedStage.name;
            if (roleName !== "Admin") query.assignedTo = userId;

            if (dateFilter && !hasSubQuery) {
              query.createdAt = dateFilter;
            }
            const deals = await Deal.find(query).populate("assignedTo", "firstName lastName email").sort({ createdAt: -1 });

            if (deals.length > 0) {
              const firstDeal = deals[0];

              let responseMsg = "";
              let finalIntent = "deal-search";
              let count = deals.length;
              let returnData = deals.map(formatDeal);

              if (lower.includes("detail") || lower.includes("info") || lower.includes("about") || lower.includes("show")) {
                responseMsg = `Deal "${firstDeal.dealName}": Stage is ${firstDeal.stage}, handled by ${firstDeal.assignedTo ? firstDeal.assignedTo.firstName + ' ' + firstDeal.assignedTo.lastName : 'Unassigned'}. Company: ${firstDeal.companyName || 'N/A'}. Value: ${firstDeal.value || 'N/A'}.`;
              } else if (lower.includes("reason") || lower.includes("lost") || lower.includes("why")) {
                if (firstDeal.stage === "Closed Lost" || firstDeal.lossReason) {
                  const reason = firstDeal.lossReason || "No specific reason recorded";
                  const notes = firstDeal.lossNotes ? ` - ${firstDeal.lossNotes}` : "";
                  responseMsg = `Deal "${firstDeal.dealName}" was lost. Reason: ${reason}${notes}.`;
                } else if (firstDeal.stage === "Rejected") {
                  const reason = firstDeal.rejectionReason || "No specific reason recorded";
                  responseMsg = `Deal "${firstDeal.dealName}" was rejected. Reason: ${reason}.`;
                } else {
                  responseMsg = `Deal "${firstDeal.dealName}" is currently in stage "${firstDeal.stage}" and has not been marked as lost.`;
                }
              } else if (lower.includes("score")) {
                responseMsg = `Deal "${firstDeal.dealName}" has its Deal Score and Health Analysis computed dynamically on your pipeline dashboard!`;
              } else if (lower.includes("task")) {
                if (Task) {
                  let taskQuery = { $or: [{ dealRef: firstDeal._id }, { dealRefs: firstDeal._id }] };
                  if (dateFilter) taskQuery.createdAt = dateFilter;
                  const tasks = await Task.find(taskQuery).populate("assignedTo", "firstName lastName");
                  responseMsg = `Deal "${firstDeal.dealName}" has ${tasks.length} associated tasks${dateLabel}.`;
                  finalIntent = "task-search";
                  count = tasks.length;
                  returnData = tasks.map(formatTask);
                } else {
                  responseMsg = `Check the CRM Tasks tab for tasks related to deal "${firstDeal.dealName}".`;
                }
              } else if (lower.includes("score")) {
                responseMsg = `Deal scores are not currently tracked in the database for deal "${firstDeal.dealName}".`;
              } else if (lower.includes("target")) {
                responseMsg = `Targets are typically managed per salesperson. Check the Tasks & Targets tab in Deal "${firstDeal.dealName}" for specifics.`;
              } else if (lower.includes("attachment") || lower.includes("document") || lower.includes("file")) {
                const countAtt = firstDeal.attachments ? firstDeal.attachments.length : 0;
                responseMsg = `Deal "${firstDeal.dealName}" has ${countAtt} uploaded attachments.`;
                finalIntent = "attachment-search";
                count = countAtt;
                returnData = firstDeal.attachments ? firstDeal.attachments.map(a => ({
                  _id: a._id || Date.now(),
                  name: a.name || a.filename || "Attachment",
                  value: a.size ? `${(a.size / 1024).toFixed(1)} KB` : "",
                  type: "attachment",
                  path: a.path,
                  handledBy: firstDeal.assignedTo ? `${firstDeal.assignedTo.firstName} ${firstDeal.assignedTo.lastName}` : "Unassigned"
                })) : [];
              } else if (lower.includes("activity")) {
                if (Activity) {
                  let actQuery = { deal: firstDeal._id };
                  if (dateFilter) actQuery.startDate = dateFilter; // Activity uses startDate
                  const activities = await Activity.find(actQuery).populate("assignedTo", "firstName lastName");
                  responseMsg = `Deal "${firstDeal.dealName}" has ${activities.length} activities${dateLabel}.`;
                  finalIntent = "activity-search";
                  count = activities.length;
                  returnData = activities.map(a => ({
                    _id: a._id,
                    name: a.title || "Activity",
                    status: a.activityCategory || "Other",
                    dueDate: a.startDate,
                    handledBy: a.assignedTo ? `${a.assignedTo.firstName} ${a.assignedTo.lastName}` : "Unassigned",
                    type: "activity"
                  }));
                } else {
                  responseMsg = `Activity history for Deal "${firstDeal.dealName}" is fully tracked in the Activity tab.`;
                  returnData = [];
                }
              } else if (lower.includes("follow") || lower.includes("history")) {
                const countFw = firstDeal.followUpHistory ? firstDeal.followUpHistory.length : 0;
                const nextFw = firstDeal.followUpDate ? new Date(firstDeal.followUpDate).toLocaleDateString() : "None";
                responseMsg = `Deal "${firstDeal.dealName}" has ${countFw} follow-up records. Next scheduled follow-up: ${nextFw}.`;
                finalIntent = "followup-search";
                count = countFw;
                returnData = firstDeal.followUpHistory ? firstDeal.followUpHistory.map(f => ({
                  _id: f._id || Date.now(),
                  name: f.followUpComment || "Follow-up",
                  status: (f.action || "Scheduled") + (f.outcome ? ` - ${f.outcome}` : ""),
                  dueDate: f.followUpDate,
                  handledBy: firstDeal.assignedTo ? `${firstDeal.assignedTo.firstName} ${firstDeal.assignedTo.lastName}` : "Unassigned",
                  type: "follow-up"
                })) : [];
              } else if (lower.includes("note")) {
                responseMsg = firstDeal.notes ? `Notes for deal "${firstDeal.dealName}": ${firstDeal.notes}` : `No notes found for deal "${firstDeal.dealName}".`;
                returnData = [];
              } else if (lower.includes("proposal")) {
                if (Proposal) {
                  let propQuery = { deal: firstDeal._id };
                  if (dateFilter) propQuery.createdAt = dateFilter;
                  const proposals = await Proposal.find(propQuery).populate("createdBy", "firstName lastName");
                  responseMsg = `Deal "${firstDeal.dealName}" has ${proposals.length} proposals${dateLabel}.`;
                  finalIntent = "proposal-search";
                  count = proposals.length;
                  returnData = proposals.map(p => ({
                    _id: p._id,
                    name: p.title,
                    status: p.status,
                    value: p.value,
                    handledBy: p.createdBy ? `${p.createdBy.firstName} ${p.createdBy.lastName}` : "Unassigned",
                    createdAt: p.createdAt,
                    type: "proposal"
                  }));
                } else {
                  responseMsg = `Proposals for deal "${firstDeal.dealName}" are available in the Proposals tab.`;
                }
              } else if (lower.includes("meeting")) {
                responseMsg = `Meetings regarding deal "${firstDeal.dealName}" can be scheduled and viewed in the Meetings tab.`;
              } else if (lower.includes("email")) {
                responseMsg = `Email communications for deal "${firstDeal.dealName}" are synced in the Email tab.`;
              } else if (Invoice && (lower.includes("balance") || lower.includes("due") || lower.includes("invoice"))) {
                let invQuery = { "items.deal": firstDeal._id };
                if (dateFilter) invQuery.createdAt = dateFilter;
                const invoices = await Invoice.find(invQuery).populate("assignTo", "firstName lastName email").sort({ createdAt: -1 });
                if (invoices.length > 0) {
                  const firstInv = invoices[0];
                  const totalNum = parseFloat(firstInv.total.replace(/[^0-9.]/g, '')) || 0;
                  const balanceDue = totalNum - firstInv.amountPaid;
                  responseMsg = `Invoice ${firstInv.invoicenumber} for deal "${firstDeal.dealName}" has a total of ${firstInv.total} ${firstInv.currency} and ${firstInv.amountPaid} ${firstInv.currency} paid. The balance due is ${balanceDue} ${firstInv.currency}.`;
                  finalIntent = "invoice-search";
                  count = invoices.length;
                  returnData = invoices.map(formatInvoice);
                } else {
                  responseMsg = `No invoices found for deal "${firstDeal.dealName}".`;
                }
              } else {
                const dealValueStr = firstDeal.value ? `, value: ${firstDeal.value}` : "";
                responseMsg = `Found deal "${firstDeal.dealName}" (stage: ${firstDeal.stage}${dealValueStr}).`;
              }

              await saveChat(AiChat, userId, message, finalIntent, responseMsg, count);
              return res.json({ success: true, intent: finalIntent, message: responseMsg, count: count, data: returnData });
            } else {
              const responseMsg = `No deals found matching "${searchTerm}"${dateLabel}.`;
              await saveChat(AiChat, userId, message, "deal-search", responseMsg, 0);
              return res.json({ success: true, intent: "deal-search", message: responseMsg, count: 0, data: [] });
            }
          }
        }

        // Check if querying deals by salesperson (smart name match)
        // (matchingUsers and matchingUserIds are already computed at the top of the Deals block)

        if (matchingUsers.length > 0) {
          let userIds = matchingUsers.map(u => u._id);
          if (roleName !== "Admin") {
            // Salespersons can only ever query their own records
            userIds = userIds.filter(id => id.toString() === userId.toString());
          }

          if (userIds.length > 0) {
            let query = { assignedTo: { $in: userIds } };
            if (dateFilter) query.createdAt = dateFilter;
            const deals = await Deal.find(query).populate("assignedTo", "firstName lastName email").sort({ createdAt: -1 });
            const salespersonNames = matchingUsers.map((sp) => `${sp.firstName} ${sp.lastName}`).join(", ");
            const responseMsg = deals.length > 0 ? `Found ${deals.length} deals assigned to ${salespersonNames}${dateLabel}.` : `No deals found for ${salespersonNames}${dateLabel}.`;
            await saveChat(AiChat, userId, message, "deals-by-salesperson", responseMsg, deals.length);
            return res.json({ success: true, intent: "deals-by-salesperson", message: responseMsg, count: deals.length, data: deals.map(formatDeal) });
          } else {
            const responseMsg = `You do not have permission to view deals assigned to other users.`;
            await saveChat(AiChat, userId, message, "deals-by-salesperson", responseMsg, 0);
            return res.json({ success: true, intent: "deals-by-salesperson", message: responseMsg, count: 0, data: [] });
          }
        }





        // Generic fallback for Deals: return all deals (filtered by date if applicable)
        let query = {};
        if (roleName !== "Admin") query.assignedTo = userId;
        if (dateFilter) query.createdAt = dateFilter;
        const allDeals = await Deal.find(query).populate("assignedTo", "firstName lastName email").sort({ createdAt: -1 });
        const allDealsMsg = allDeals.length > 0 ? `You have ${allDeals.length} deals${dateLabel}.` : `No deals found${dateLabel}.`;
        await saveChat(AiChat, userId, message, "deals-list", allDealsMsg, allDeals.length);
        return res.json({ success: true, intent: "deals-list", message: allDealsMsg, count: allDeals.length, data: allDeals.map(formatDeal) });
      }

      // --- 7. LEADS ---
      if (Lead && (lower.includes("lead") || lower.includes("leads"))) {
        // First check if it is asking for total/count/list/show
        const isListOrCount = lower.includes("total") || lower.includes("all") || lower.includes("how many") || lower.includes("show") || lower.includes("list") || lower.includes("names") || lower.includes("name");

        // Search specific lead by name/company if we are NOT asking for a general list/count and have extra words
        const searchTerms = lower.split(/\s+/).filter(w => w && w.length > 1 && !stopWords.includes(w) && !(dateFilter && !isNaN(w)));

        // Check if querying leads by salesperson (smart name match)
        if (searchTerms.length > 0) {
          const matchingUsers = await User.find({
            $or: [
              { firstName: { $in: searchTerms.map(w => new RegExp(`^${w}`, "i")) } },
              { lastName: { $in: searchTerms.map(w => new RegExp(`^${w}`, "i")) } }
            ]
          }).select("_id firstName lastName email");

          if (matchingUsers.length > 0) {
            let userIds = matchingUsers.map(u => u._id);
            if (roleName !== "Admin") {
              userIds = userIds.filter(id => id.toString() === userId.toString());
            }

            if (userIds.length > 0) {
              let query = { assignTo: { $in: userIds } };
              let statusLabel = "";
              
              if (lower.includes("hot") || lower.includes("highly interested")) {
                query.status = "Hot"; statusLabel = "hot ";
              } else if (lower.includes("warm") || lower.includes("interested")) {
                query.status = "Warm"; statusLabel = "warm ";
              } else if (lower.includes("cold") || lower.includes("not interested")) {
                query.status = "Cold"; statusLabel = "cold ";
              } else if (lower.includes("converted") || lower.includes("won lead") || lower.includes("successful lead")) {
                query.status = "Converted"; statusLabel = "converted ";
                if (dateFilter) query.updatedAt = dateFilter;
              } else if (lower.includes("junk") || lower.includes("spam") || lower.includes("fake") || lower.includes("garbage")) {
                query.status = "Junk"; statusLabel = "junk ";
              } else if (lower.includes("rejected") || lower.includes("declined") || lower.includes("unqualified") || lower.includes("dropped")) {
                query.status = "Rejected"; statusLabel = "rejected ";
              }

              if (dateFilter && !lower.includes("converted")) query.createdAt = dateFilter;

              const leads = await Lead.find(query).populate("assignTo", "firstName lastName email").sort({ createdAt: -1 });
              const salespersonNames = matchingUsers.map((sp) => `${sp.firstName} ${sp.lastName}`).join(", ");
              const responseMsg = leads.length > 0 ? `Found ${leads.length} ${statusLabel}leads assigned to ${salespersonNames}${dateLabel}.` : `No ${statusLabel}leads found for ${salespersonNames}${dateLabel}.`;
              await saveChat(AiChat, userId, message, "leads-by-salesperson", responseMsg, leads.length);
              return res.json({ success: true, intent: "leads-by-salesperson", message: responseMsg, count: leads.length, data: leads.map(formatLead) });
            } else {
              const responseMsg = `You do not have permission to view leads assigned to other users.`;
              await saveChat(AiChat, userId, message, "leads-by-salesperson", responseMsg, 0);
              return res.json({ success: true, intent: "leads-by-salesperson", message: responseMsg, count: 0, data: [] });
            }
          }
        }


        // If asking for a specific lead search
        let specificLeadName = "";
        const leadMatches = [...message.matchAll(/lead\s+([A-Za-z0-9_-]+)/gi)];
        if (leadMatches.length > 0) {
          const invalidNames = ["score", "tasks", "task", "invoice", "invoices", "activity", "activities", "history", "notes", "proposal", "proposals", "attachment", "attachments", "document", "documents", "file", "files", "details", "info", "target", "targets", "meeting", "email", "follow", "status", "by", "for", "with", "of", "to", "in", "on", "at", "about", "called", "named"];
          const validMatches = leadMatches.filter(m => !invalidNames.includes(m[1].toLowerCase()));
          if (validMatches.length > 0) {
            specificLeadName = validMatches[validMatches.length - 1][1].trim();
          }
        }

        if (!specificLeadName && searchTerms.length > 0 && !lower.includes("hot") && !lower.includes("warm") && !lower.includes("cold") && !lower.includes("my") && !isListOrCount) {
          specificLeadName = searchTerms[0];
        }

        if (specificLeadName) {
          let query = {
            $or: [
              { leadName: { $regex: specificLeadName, $options: "i" } },
              { companyName: { $regex: specificLeadName, $options: "i" } },
              { email: { $regex: specificLeadName, $options: "i" } }
            ]
          };
          if (roleName !== "Admin") query.assignTo = userId;

          const hasSubQuery = lower.includes("attachment") || lower.includes("document") || lower.includes("file") || lower.includes("task") || lower.includes("activity");
          if (dateFilter && !hasSubQuery) query.createdAt = dateFilter;

          const leads = await Lead.find(query).populate("assignTo", "firstName lastName email").sort({ createdAt: -1 });

          if (leads.length > 0) {
            const firstLead = leads[0];
            let responseMsg = "";
            let finalIntent = "lead-search";
            let count = 1;
            let returnData = [formatLead(firstLead)];

            if (lower.includes("attachment") || lower.includes("document") || lower.includes("file")) {
              const countAtt = firstLead.attachments ? firstLead.attachments.length : 0;
              responseMsg = `Lead "${firstLead.leadName}" has ${countAtt} uploaded attachments.`;
              finalIntent = "attachment-search";
              count = countAtt;
              returnData = firstLead.attachments ? firstLead.attachments.map(a => ({
                _id: a._id || Date.now(),
                name: a.name || a.filename || "Attachment",
                value: a.size ? `${(a.size / 1024).toFixed(1)} KB` : "",
                type: "attachment",
                path: a.path,
                handledBy: firstLead.assignTo ? `${firstLead.assignTo.firstName} ${firstLead.assignTo.lastName}` : "Unassigned"
              })) : [];
            } else {
              responseMsg = `Found lead "${firstLead.leadName}".`;
            }

            await saveChat(AiChat, userId, message, finalIntent, responseMsg, count);
            return res.json({ success: true, intent: finalIntent, message: responseMsg, count: count, data: returnData });
          } else {
            const responseMsg = `No lead found matching "${specificLeadName}"${dateLabel}.`;
            await saveChat(AiChat, userId, message, "lead-search", responseMsg, 0);
            return res.json({ success: true, intent: "lead-search", message: responseMsg, count: 0, data: [] });
          }
        }

        // Filter by status or assigned
        let query = {};
        let intentName = "leads-list";
        let statusLabel = "";

        if (lower.includes("hot") || lower.includes("highly interested")) {
          query.status = "Hot";
          intentName = "leads-hot";
          statusLabel = "hot ";
        } else if (lower.includes("warm") || lower.includes("interested")) {
          query.status = "Warm";
          intentName = "leads-warm";
          statusLabel = "warm ";
        } else if (lower.includes("cold") || lower.includes("not interested")) {
          query.status = "Cold";
          intentName = "leads-cold";
          statusLabel = "cold ";
        } else if (lower.includes("converted") || lower.includes("won lead") || lower.includes("successful lead")) {
          query.status = "Converted";
          intentName = "leads-converted";
          statusLabel = "converted ";
          if (dateFilter) query.updatedAt = dateFilter; // Converted leads are filtered by conversion/updated time
        } else if (lower.includes("junk") || lower.includes("spam") || lower.includes("fake") || lower.includes("garbage")) {
          query.status = "Junk";
          intentName = "leads-junk";
          statusLabel = "junk ";
        } else if (lower.includes("rejected")) {
          query.status = "Rejected";
          intentName = "leads-rejected";
          statusLabel = "rejected ";
        }

        if (roleName !== "Admin" || lower.includes("my")) {
          query.assignTo = userId;
          intentName += "-mine";
        }
        if (dateFilter && !lower.includes("converted")) query.createdAt = dateFilter;

        const leads = await Lead.find(query).populate("assignTo", "firstName lastName email").sort({ createdAt: -1 });
        const responseMsg = `You have ${leads.length} ${statusLabel}leads${dateLabel}.`;
        await saveChat(AiChat, userId, message, intentName, responseMsg, leads.length);
        return res.json({ success: true, intent: intentName, message: responseMsg, count: leads.length, data: leads.map(formatLead) });
      }

      const fallbackMsg = "I couldn't quite understand that request. For best results, try asking specific questions like: 'Show my pending tasks', 'Find unpaid invoices', 'List my active targets', or 'Show my deals'.";
      await saveChat(AiChat, userId, message, "unknown", fallbackMsg, 0);
      return res.json({ success: true, intent: "unknown", message: fallbackMsg, data: [] });

    } catch (err) {
      console.error("AI ERROR:", err);
      console.error(err);
      res.status(500).json({ success: false, message: "AI processing failed", error: err.stack });
    }
  },

  getChatHistory: async (req, res) => {
    try {
      const models = getModels(req);
      const AiChat = models.AiChat;
      if (!AiChat) return res.status(400).json({ success: false, message: "Chat history unavailable in non-tenant mode" });
      const userId = req.user._id;
      const limit = parseInt(req.query.limit) || 50;
      const history = await AiChat.find({ userId }).sort({ createdAt: -1 }).limit(limit).lean();
      res.json({ success: true, count: history.length, data: history });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
};

async function handleLeadStatus(status, userId, roleName, res, Lead, AiChat, message, dateFilter, dateLabel) {
  let query = { status };
  if (roleName !== "Admin") query.assignTo = userId;
  if (dateFilter) query.createdAt = dateFilter;
  const leads = await Lead.find(query).populate("assignTo", "firstName lastName email").sort({ createdAt: -1 });
  const responseMsg = `You have ${leads.length} ${status.toLowerCase()} leads${dateLabel || ""}.`;
  await saveChat(AiChat, userId, message, `leads-${status.toLowerCase()}`, responseMsg, leads.length);
  return res.json({ success: true, intent: `leads-${status.toLowerCase()}`, message: responseMsg, count: leads.length, data: leads.map(formatLead) });
}

function formatDeal(deal) {
  const STAGE_WEIGHT = {
    "Qualification": 10,
    "Proposal Sent-Negotiation": 40,
    "Invoice Sent": 70,
    "Closed Won": 100,
    "Closed Lost": 0,
    "Rejected": 0
  };
  const score = STAGE_WEIGHT[deal.stage] ?? 10;

  return {
    _id: deal._id, dealName: deal.dealName, name: deal.dealName, stage: deal.stage, status: deal.stage,
    score: score,
    value: deal.value ? String(deal.value) : null,
    companyName: deal.companyName, company: deal.companyName,
    phoneNumber: deal.phoneNumber, phone: deal.phoneNumber,
    handledBy: deal.assignedTo ? `${deal.assignedTo.firstName} ${deal.assignedTo.lastName}` : "Unassigned",
    assignedTo: deal.assignedTo, createdAt: deal.createdAt, type: "deal",
    lossReason: deal.lossReason, lossNotes: deal.lossNotes
  };
}

function formatLead(lead) {
  return {
    _id: lead._id, leadName: lead.leadName, name: lead.leadName,
    phoneNumber: lead.phoneNumber, phone: lead.phoneNumber,
    email: lead.email, companyName: lead.companyName, company: lead.companyName,
    status: lead.status, source: lead.source,
    handledBy: lead.assignTo ? `${lead.assignTo.firstName} ${lead.assignTo.lastName}` : "Unassigned",
    assignTo: lead.assignTo, createdAt: lead.createdAt, type: "lead",
  };
}

function formatInvoice(invoice) {
  return {
    _id: invoice._id,
    invoiceNumber: invoice.invoicenumber,
    name: invoice.invoicenumber,
    status: invoice.status,
    total: invoice.total,
    currency: invoice.currency,
    dueDate: invoice.dueDate,
    handledBy: invoice.assignTo ? `${invoice.assignTo.firstName} ${invoice.assignTo.lastName}` : "Unassigned",
    assignTo: invoice.assignTo,
    createdAt: invoice.createdAt,
    type: "invoice",
  };
}

function formatTask(task) {
  return {
    _id: task._id,
    title: task.title,
    name: task.title,
    description: task.description,
    priority: task.priority,
    status: task.status,
    dueDate: task.dueDate,
    handledBy: task.assignedTo ? `${task.assignedTo.firstName} ${task.assignedTo.lastName}` : "Unassigned",
    assignedTo: task.assignedTo,
    createdAt: task.createdAt,
    type: "task",
  };
}

function formatProposal(p) {
  return {
    _id: p._id,
    name: p.title,
    status: p.status,
    value: p.value,
    handledBy: p.createdBy ? `${p.createdBy.firstName} ${p.createdBy.lastName}` : "Unassigned",
    createdAt: p.createdAt,
    type: "proposal"
  };
}

async function computeTargetActuals(target, models) {
  const { Lead, Deal } = models;
  const start = new Date(target.startDate);
  const end = new Date(target.endDate);
  end.setHours(23, 59, 59, 999);

  let leadsConverted = 0;
  let dealsWon = 0;

  if (target.linkedLeads && target.linkedLeads.length > 0) {
    leadsConverted = await Deal.countDocuments({ leadId: { $in: target.linkedLeads } });
  } else if (target.targetLeads > 0) {
    const spId = target.salesPerson?._id || target.salesPerson;
    leadsConverted = await Lead.countDocuments({ assignTo: spId, status: "Converted", updatedAt: { $gte: start, $lte: end } });
  }

  if (target.linkedDeals && target.linkedDeals.length > 0) {
    dealsWon = await Deal.countDocuments({ _id: { $in: target.linkedDeals }, stage: "Closed Won" });
  } else if (target.targetDeals > 0) {
    const spId = target.salesPerson?._id || target.salesPerson;
    dealsWon = await Deal.countDocuments({ assignedTo: spId, stage: "Closed Won", wonAt: { $gte: start, $lte: end } });
  }

  return {
    leadsConverted,
    dealsWon,
    calls: target.reportedCalls ? target.reportedCalls.length : 0,
    meetings: target.reportedMeetings ? target.reportedMeetings.length : 0
  };
}

function formatTarget(target) {
  return {
    _id: target._id,
    salesPerson: target.salesPerson,
    name: `${target.period} target for ${target.salesPerson ? `${target.salesPerson.firstName} ${target.salesPerson.lastName}` : "Unknown"}`,
    period: target.period,
    status: target.status,
    startDate: target.startDate,
    endDate: target.endDate,
    targetLeads: target.targetLeads,
    targetDeals: target.targetDeals,
    targetCalls: target.targetCalls,
    targetMeetings: target.targetMeetings,
    actualLeadsConverted: target.actuals?.leadsConverted || 0,
    actualDealsClosed: target.actuals?.dealsWon || 0,
    actualCalls: target.actuals?.calls || 0,
    actualMeetings: target.actuals?.meetings || 0,
    handledBy: target.salesPerson ? `${target.salesPerson.firstName} ${target.salesPerson.lastName}` : "Unassigned",
    createdAt: target.createdAt,
    type: "target",
  };
}

function formatUser(user) {
  return {
    _id: user._id,
    type: "user",
    name: `${user.firstName} ${user.lastName}`,
    email: user.email,
    isActive: user.isActive,
    role: user.role?.name || "User",
    createdAt: user.createdAt,
    ...user.toObject ? user.toObject() : user
  };
}

function formatClientLTV(clv) {
  return {
    _id: clv._id,
    type: "clv_client",
    companyName: clv.companyName || "Unknown Client",
    status: clv.classification,
    total: clv.totalRevenue?.toLocaleString() || "0",
    lossReason: clv.classificationReason,
    ...clv.toObject ? clv.toObject() : clv
  };
}
