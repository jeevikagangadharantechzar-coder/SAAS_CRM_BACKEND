import { getTenantModels } from "../models/tenant/index.js";
import DealLegacy from "../models/deals.model.js";
import LeadLegacy from "../models/leads.model.js";
import UserLegacy from "../models/user.model.js";

const getModels = (req) =>
  req.tenantDB
    ? getTenantModels(req.tenantDB)
    : { Deal: DealLegacy, Lead: LeadLegacy, User: UserLegacy, AiChat: null };

async function saveChat(AiChat, userId, message, intent, response, resultCount = 0) {
  if (!AiChat) return;
  try {
    await AiChat.create({ userId, message, intent, response, resultCount });
  } catch (err) {
    console.error("AiChat save failed (non-fatal):", err.message);
  }
}

export default {
  processMessage: async (req, res) => {
    try {
      const payload = req.method === "GET" ? req.query : req.body;
      const { message } = payload;

      if (!message) {
        return res.status(400).json({ success: false, message: "Message required" });
      }

      const { Deal, Lead, User, AiChat } = getModels(req);
      const userId = req.user._id;
      const roleName =
        typeof req.user.role === "object" ? req.user.role.name : req.user.role;
      const lower = message.toLowerCase();

      if (lower.includes("deals won") || lower.includes("won deals") || (lower.includes("won") && lower.includes("deal"))) {
        let query = { stage: "Closed Won" };
        if (roleName !== "Admin") query.assignedTo = userId;
        const deals = await Deal.find(query).populate("assignedTo", "firstName lastName email").sort({ createdAt: -1 });
        const responseMsg = `You have ${deals.length} won deals.`;
        await saveChat(AiChat, userId, message, "deals-won", responseMsg, deals.length);
        return res.json({ success: true, intent: "deals-won", message: responseMsg, count: deals.length, data: deals.map(formatDeal) });
      }

      if (lower.includes("deals lost") || lower.includes("lost deals") || (lower.includes("lost") && lower.includes("deal"))) {
        let query = { stage: "Closed Lost" };
        if (roleName !== "Admin") query.assignedTo = userId;
        const deals = await Deal.find(query).populate("assignedTo", "firstName lastName email").sort({ createdAt: -1 });
        const responseMsg = `You have ${deals.length} lost deals.`;
        await saveChat(AiChat, userId, message, "deals-lost", responseMsg, deals.length);
        return res.json({ success: true, intent: "deals-lost", message: responseMsg, count: deals.length, data: deals.map(formatDeal) });
      }

      if (lower.includes("open deals") || lower.includes("deals open") || (lower.includes("open") && lower.includes("deal"))) {
        let query = { stage: { $nin: ["Closed Won", "Closed Lost"] } };
        if (roleName !== "Admin") query.assignedTo = userId;
        const deals = await Deal.find(query).populate("assignedTo", "firstName lastName email").sort({ createdAt: -1 });
        const responseMsg = `You have ${deals.length} open deals.`;
        await saveChat(AiChat, userId, message, "deals-open", responseMsg, deals.length);
        return res.json({ success: true, intent: "deals-open", message: responseMsg, count: deals.length, data: deals.map(formatDeal) });
      }

      if (lower.includes("my deals") || lower === "my deals") {
        const deals = await Deal.find({ assignedTo: userId }).populate("assignedTo", "firstName lastName email").sort({ createdAt: -1 });
        const responseMsg = `You have ${deals.length} deal${deals.length !== 1 ? "s" : ""} assigned to you.`;
        await saveChat(AiChat, userId, message, "my-deals", responseMsg, deals.length);
        return res.json({ success: true, intent: "my-deals", message: responseMsg, count: deals.length, data: deals.map(formatDeal) });
      }

      if (lower.includes("deals by") || lower.includes("deals of") || lower.includes("assigned to") || lower.includes("handled by")) {
        let searchName = lower.replace(/deals by|deals of|assigned to|handled by|show|get|find|search|for|name/gi, "").trim();
        if (searchName.length > 1) {
          const nameParts = searchName.split(" ");
          let userQuery;
          if (nameParts.length > 1) {
            userQuery = { $or: [
              { firstName: { $regex: nameParts[0], $options: "i" }, lastName: { $regex: nameParts[1], $options: "i" } },
              { firstName: { $regex: nameParts[1], $options: "i" }, lastName: { $regex: nameParts[0], $options: "i" } },
            ]};
          } else {
            userQuery = { $or: [{ firstName: { $regex: searchName, $options: "i" } }, { lastName: { $regex: searchName, $options: "i" } }] };
          }
          const salespersons = await User.find(userQuery).select("_id firstName lastName email");
          if (salespersons.length > 0) {
            const userIds = salespersons.map((sp) => sp._id);
            const deals = await Deal.find({ assignedTo: { $in: userIds } }).populate("assignedTo", "firstName lastName email").sort({ createdAt: -1 });
            const salespersonNames = salespersons.map((sp) => `${sp.firstName} ${sp.lastName}`).join(", ");
            const responseMsg = deals.length > 0 ? `Found ${deals.length} deals handled by ${salespersonNames}` : `No deals found for ${salespersonNames}`;
            await saveChat(AiChat, userId, message, "deals-by-salesperson", responseMsg, deals.length);
            return res.json({ success: true, intent: "deals-by-salesperson", message: responseMsg, count: deals.length, data: deals.map(formatDeal) });
          }
        }
      }

      if (lower.includes("deal ") && !lower.includes("deals ")) {
        let searchTerm = lower.replace(/deal|show|get|find|search|for|about|named|called/gi, "").trim();
        if (searchTerm.length > 1) {
          let query = { dealName: { $regex: searchTerm, $options: "i" } };
          if (roleName !== "Admin") query.assignedTo = userId;
          const deals = await Deal.find(query).populate("assignedTo", "firstName lastName email").sort({ createdAt: -1 });
          const responseMsg = deals.length > 0 ? `Found ${deals.length} deals matching "${searchTerm}"` : `No deals found matching "${searchTerm}"`;
          await saveChat(AiChat, userId, message, "deal-search", responseMsg, deals.length);
          return res.json({ success: true, intent: "deal-search", message: responseMsg, count: deals.length, data: deals.map(formatDeal) });
        }
      }

      if (lower.includes("hot leads"))  return handleLeadStatus("Hot",  userId, roleName, res, Lead, AiChat, message);
      if (lower.includes("warm leads")) return handleLeadStatus("Warm", userId, roleName, res, Lead, AiChat, message);
      if (lower.includes("cold leads")) return handleLeadStatus("Cold", userId, roleName, res, Lead, AiChat, message);

      if (lower.includes("my leads")) {
        const leads = await Lead.find({ assignTo: userId }).populate("assignTo", "firstName lastName email").sort({ createdAt: -1 });
        const responseMsg = `You have ${leads.length} leads assigned to you.`;
        await saveChat(AiChat, userId, message, "my-leads", responseMsg, leads.length);
        return res.json({ success: true, intent: "my-leads", message: responseMsg, count: leads.length, data: leads.map(formatLead) });
      }

      const fallbackMsg = "Try: 'deals by rosy', 'deal carcare', 'open deals', 'hot leads', 'my deals'";
      await saveChat(AiChat, userId, message, "unknown", fallbackMsg, 0);
      return res.json({ success: true, intent: "unknown", message: fallbackMsg, data: [] });

    } catch (err) {
      console.error("AI ERROR:", err);
      res.status(500).json({ success: false, message: "AI processing failed", error: err.message });
    }
  },

  getChatHistory: async (req, res) => {
    try {
      const models = getModels(req);
      const AiChat = models.AiChat;
      if (!AiChat) return res.status(400).json({ success: false, message: "Chat history unavailable in non-tenant mode" });
      const userId = req.user._id;
      const limit  = parseInt(req.query.limit) || 50;
      const history = await AiChat.find({ userId }).sort({ createdAt: -1 }).limit(limit).lean();
      res.json({ success: true, count: history.length, data: history });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
};

async function handleLeadStatus(status, userId, roleName, res, Lead, AiChat, message) {
  let query = { status };
  if (roleName !== "Admin") query.assignTo = userId;
  const leads = await Lead.find(query).populate("assignTo", "firstName lastName email").sort({ createdAt: -1 });
  const responseMsg = `You have ${leads.length} ${status.toLowerCase()} leads.`;
  await saveChat(AiChat, userId, message, `leads-${status.toLowerCase()}`, responseMsg, leads.length);
  return res.json({ success: true, intent: `leads-${status.toLowerCase()}`, message: responseMsg, count: leads.length, data: leads.map(formatLead) });
}

function formatDeal(deal) {
  return {
    _id: deal._id, dealName: deal.dealName, name: deal.dealName, stage: deal.stage, status: deal.stage,
    value: deal.value && deal.value > 0 ? `$${deal.value}` : null,
    companyName: deal.companyName, company: deal.companyName,
    phoneNumber: deal.phoneNumber, phone: deal.phoneNumber,
    handledBy: deal.assignedTo ? `${deal.assignedTo.firstName} ${deal.assignedTo.lastName}` : "Unassigned",
    assignedTo: deal.assignedTo, createdAt: deal.createdAt, type: "deal",
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
