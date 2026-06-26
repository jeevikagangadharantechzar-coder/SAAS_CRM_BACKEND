import { getTenantModels } from "../models/tenant/index.js";
import { notifyUser } from "../realtime/socket.js";

const getModels = (req) => getTenantModels(req.tenantDB);

async function createNotification(Notification, { userId, title, message, type, meta }) {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const notif = await Notification.create({
    userId,
    title,
    message,
    text: message,
    type,
    meta,
    expiresAt,
    read: false,
    isRead: false,
  });
  notifyUser(String(userId), "new_notification", {
    _id: notif._id,
    title,
    text: message,
    message,
    type,
    meta,
    createdAt: notif.createdAt,
  });
  return notif;
}

async function findAdmins(User, Role) {
  const adminRole = await Role.findOne({ name: "Admin" });
  if (!adminRole) return [];
  return User.find({ role: adminRole._id, status: "Active" }).select("_id");
}

// Compute actual counts for a user within a date range, scoped to linked leads/deals if provided
async function computeActuals(models, userId, startDate, endDate, linkedLeadIds = null, linkedDealIds = null) {
  const { Lead, Deal, CallLog, Activity } = models;

  const start = new Date(startDate);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  // Leads converted: leads become deals on conversion (lead is deleted), so count deals created from linked leads
  const leadsConvertedQuery = linkedLeadIds && linkedLeadIds.length > 0
    ? Deal.countDocuments({ leadId: { $in: linkedLeadIds } })
    : Lead.countDocuments({ assignTo: userId, status: "Converted", updatedAt: { $gte: start, $lte: end } });

  // Deals won: if specific deals are linked, count only those that are "Closed Won"
  const dealsWonQuery = linkedDealIds && linkedDealIds.length > 0
    ? Deal.countDocuments({ _id: { $in: linkedDealIds }, stage: "Closed Won" })
    : Deal.countDocuments({ assignedTo: userId, stage: "Closed Won", updatedAt: { $gte: start, $lte: end } });

  const [leadsConverted, dealsWon, calls, meetings] = await Promise.all([
    leadsConvertedQuery,
    dealsWonQuery,
    CallLog.countDocuments({ userId: userId, createdAt: { $gte: start, $lte: end } }),
    Activity.countDocuments({ assignedTo: userId, activityCategory: "Meeting", startDate: { $gte: start, $lte: end } }),
  ]);

  return { leadsConverted, dealsWon, calls, meetings };
}

export default {
  // Admin: get all targets with progress
  getTargets: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied: Admins only" });
      }
      const models = getModels(req);
      const { Target } = models;

      const { Lead, Deal } = models;
      // Step 1: lean fetch to get raw ObjectIds for accurate counting
      const rawTargets = await Target.find()
        .populate("salesPerson", "firstName lastName email")
        .populate("createdBy", "firstName lastName email")
        .populate("notes.addedBy", "firstName lastName")
        .sort({ createdAt: -1 })
        .lean();

      const result = await Promise.all(rawTargets.map(async (t) => {
        const rawLeadIds = (t.linkedLeads || []);
        const rawDealIds = (t.linkedDeals || []);

        // Counts use raw IDs (works even for deleted leads)
        const actuals = await computeActuals(models, t.salesPerson._id, t.startDate, t.endDate, rawLeadIds, rawDealIds);

        // Populate existing leads (deleted ones are simply absent)
        const existingLeads = await Lead.find({ _id: { $in: rawLeadIds } })
          .select("leadName companyName phoneNumber email status createdAt statusHistory")
          .lean();

        // Deals created from converted linked leads (carry status history)
        const convertedLeadDeals = await Deal.find({ leadId: { $in: rawLeadIds } })
          .select("dealName leadId convertedAt createdAt stage value currency leadStatusHistory leadCreatedAt stageHistory lossReason lossNotes stageLostAt updatedAt companyName phoneNumber email")
          .lean();

        // Populate linked deals
        const existingDeals = await Deal.find({ _id: { $in: rawDealIds } })
          .select("dealName dealTitle companyName phoneNumber email stage value currency wonAt convertedAt createdAt stageHistory lossReason lossNotes stageLostAt updatedAt")
          .lean();

        // Count leads that converted to a deal AND that deal is Closed Won
        const leadDealWon = convertedLeadDeals.filter(d => d.stage === "Closed Won").length;
        actuals.leadDealWon = leadDealWon;

        // Count all Closed Lost deals (linked deals + converted lead deals)
        const dealsLost =
          existingDeals.filter(d => d.stage === "Closed Lost").length +
          convertedLeadDeals.filter(d => d.stage === "Closed Lost").length;
        actuals.dealsLost = dealsLost;

        const leadsPercent = t.targetLeads > 0 ? Math.min(100, Math.round((actuals.leadsConverted / t.targetLeads) * 100)) : 0;
        const dealsPercent = t.targetDeals > 0 ? Math.min(100, Math.round((actuals.dealsWon / t.targetDeals) * 100)) : 0;
        const callsPercent = t.targetCalls > 0 ? Math.min(100, Math.round((actuals.calls / t.targetCalls) * 100)) : 0;
        const meetingsPercent = t.targetMeetings > 0 ? Math.min(100, Math.round((actuals.meetings / t.targetMeetings) * 100)) : 0;
        const overall = Math.round((leadsPercent + dealsPercent + callsPercent + meetingsPercent) / 4);

        return {
          ...t,
          linkedLeads: existingLeads,
          linkedDeals: existingDeals,
          convertedLeadDeals,
          actuals,
          percentages: { leadsPercent, dealsPercent, callsPercent, meetingsPercent, overall },
        };
      }));

      res.status(200).json(result);
    } catch (err) {
      console.error("Error fetching targets:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Sales: get only their own targets with progress
  getMyTargets: async (req, res) => {
    try {
      const models = getModels(req);
      const { Target } = models;

      const { Lead, Deal } = models;
      console.log("[getMyTargets] userId:", String(req.user._id));
      const rawTargets = await Target.find({ salesPerson: req.user._id })
        .populate("salesPerson", "firstName lastName email")
        .populate("createdBy", "firstName lastName email")
        .populate("notes.addedBy", "firstName lastName")
        .sort({ createdAt: -1 })
        .lean();

      console.log("[getMyTargets] rawTargets found:", rawTargets.length);
      const result = await Promise.all(rawTargets.map(async (t) => {
        const rawLeadIds = (t.linkedLeads || []);
        const rawDealIds = (t.linkedDeals || []);

        const actuals = await computeActuals(models, req.user._id, t.startDate, t.endDate, rawLeadIds, rawDealIds);

        const existingLeads = await Lead.find({ _id: { $in: rawLeadIds } })
          .select("leadName companyName phoneNumber email status createdAt statusHistory")
          .lean();

        const convertedLeadDeals = await Deal.find({ leadId: { $in: rawLeadIds } })
          .select("dealName leadId convertedAt createdAt stage value currency leadStatusHistory leadCreatedAt stageHistory lossReason lossNotes stageLostAt updatedAt companyName phoneNumber email")
          .lean();

        const existingDeals = await Deal.find({ _id: { $in: rawDealIds } })
          .select("dealName dealTitle companyName phoneNumber email stage value currency wonAt convertedAt createdAt stageHistory lossReason lossNotes stageLostAt updatedAt")
          .lean();

        // Count leads that converted to a deal AND that deal is Closed Won
        const leadDealWon = convertedLeadDeals.filter(d => d.stage === "Closed Won").length;
        actuals.leadDealWon = leadDealWon;

        // Count all Closed Lost deals (linked deals + converted lead deals)
        const dealsLost =
          existingDeals.filter(d => d.stage === "Closed Lost").length +
          convertedLeadDeals.filter(d => d.stage === "Closed Lost").length;
        actuals.dealsLost = dealsLost;

        const leadsPercent = t.targetLeads > 0 ? Math.min(100, Math.round((actuals.leadsConverted / t.targetLeads) * 100)) : 0;
        const dealsPercent = t.targetDeals > 0 ? Math.min(100, Math.round((actuals.dealsWon / t.targetDeals) * 100)) : 0;
        const callsPercent = t.targetCalls > 0 ? Math.min(100, Math.round((actuals.calls / t.targetCalls) * 100)) : 0;
        const meetingsPercent = t.targetMeetings > 0 ? Math.min(100, Math.round((actuals.meetings / t.targetMeetings) * 100)) : 0;
        const overall = Math.round((leadsPercent + dealsPercent + callsPercent + meetingsPercent) / 4);

        return {
          ...t,
          linkedLeads: existingLeads,
          linkedDeals: existingDeals,
          convertedLeadDeals,
          actuals,
          percentages: { leadsPercent, dealsPercent, callsPercent, meetingsPercent, overall },
        };
      }));

      res.status(200).json(result);
    } catch (err) {
      console.error("Error fetching my targets:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: get a specific sales person's detailed lead/deal data for the modal preview
  getSalesPersonSummary: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied: Admins only" });
      }
      const models = getModels(req);
      const { Lead, Deal } = models;
      const { userId } = req.params;

      const [leads, deals] = await Promise.all([
        Lead.find({ assignTo: userId })
          .select("leadName companyName phoneNumber email status createdAt updatedAt")
          .sort({ createdAt: -1 }),
        Deal.find({ assignedTo: userId })
          .select("dealName dealTitle stage value currency companyName phoneNumber email createdAt updatedAt wonAt convertedAt")
          .sort({ createdAt: -1 }),
      ]);

      // Group leads by status
      const leadsByStatus = leads.reduce((acc, l) => {
        acc[l.status] = (acc[l.status] || 0) + 1;
        return acc;
      }, {});

      // Group deals by stage
      const dealsByStage = deals.reduce((acc, d) => {
        acc[d.stage] = (acc[d.stage] || 0) + 1;
        return acc;
      }, {});

      // Enrich won deals with days taken
      const enrichedDeals = deals.map((d) => {
        const obj = d.toObject();
        if (d.stage === "Closed Won" && d.wonAt) {
          const start = new Date(d.createdAt);
          const end = new Date(d.wonAt);
          const diffMs = end - start;
          const days = Math.max(0, Math.round(diffMs / (1000 * 60 * 60 * 24)));
          obj.daysTaken = days;
          obj.wonAtFormatted = end.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
        }
        return obj;
      });

      res.status(200).json({
        leads: {
          total: leads.length,
          byStatus: leadsByStatus,
          list: leads.map((l) => ({
            _id: l._id,
            leadName: l.leadName,
            companyName: l.companyName,
            phoneNumber: l.phoneNumber,
            email: l.email,
            status: l.status,
            createdAt: l.createdAt,
          })),
        },
        deals: {
          total: deals.length,
          byStage: dealsByStage,
          list: enrichedDeals.map((d) => ({
            _id: d._id,
            dealName: d.dealName || d.dealTitle,
            companyName: d.companyName,
            phoneNumber: d.phoneNumber,
            email: d.email,
            stage: d.stage,
            value: d.value,
            currency: d.currency || "INR",
            createdAt: d.createdAt,
            wonAt: d.wonAt,
            wonAtFormatted: d.wonAtFormatted,
            daysTaken: d.daysTaken,
          })),
        },
      });
    } catch (err) {
      console.error("Error fetching sales person summary:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: create target for a sales person
  createTarget: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied: Admins only" });
      }
      const { Target, Notification } = getModels(req);
      const { salesPerson, period, startDate, endDate, targetLeads, targetDeals, targetCalls, targetMeetings, linkedLeads, linkedDeals, description } = req.body;

      const target = await Target.create({
        salesPerson,
        period,
        startDate,
        endDate,
        description: description || "",
        targetLeads: targetLeads || 0,
        targetDeals: targetDeals || 0,
        targetCalls: targetCalls || 0,
        targetMeetings: targetMeetings || 0,
        linkedLeads: linkedLeads || [],
        linkedDeals: linkedDeals || [],
        createdBy: req.user._id,
      });

      const populated = await target.populate([
        { path: "salesPerson", select: "firstName lastName email" },
        { path: "createdBy", select: "firstName lastName email" },
        { path: "linkedLeads", select: "leadName companyName phoneNumber email status" },
        { path: "linkedDeals", select: "dealName dealTitle companyName phoneNumber email stage value currency wonAt" },
      ]);

      // Notify the assigned sales person
      const adminName = `${req.user.firstName} ${req.user.lastName}`;
      const periodLabel = period === "weekly" ? "weekly" : "monthly";
      const descSuffix = description?.trim() ? ` Message from admin: "${description.trim()}"` : "";
      await createNotification(Notification, {
        userId: salesPerson,
        title: "New Target Assigned",
        message: `Admin ${adminName} set a new ${periodLabel} target for you.${descSuffix} Check My Targets to see the details.`,
        type: "target",
        meta: { targetId: String(target._id), targetAssigned: true },
      });

      // Real-time: notify sales person + all admins to refresh immediately
      notifyUser(String(salesPerson), "targets_refresh", {});
      try {
        const { User, Role } = getModels(req);
        const admins = await findAdmins(User, Role);
        admins.forEach(a => notifyUser(String(a._id), "targets_refresh", {}));
      } catch (_) {}

      res.status(201).json({ message: "Target created successfully", data: populated });
    } catch (err) {
      console.error("Error creating target:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: update target
  updateTarget: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied: Admins only" });
      }
      const { Target, Notification } = getModels(req);
      const updated = await Target.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
        runValidators: true,
      }).populate("salesPerson", "firstName lastName email")
        .populate("linkedLeads", "leadName")
        .populate("linkedDeals", "dealName dealTitle");

      if (!updated) return res.status(404).json({ message: "Target not found" });

      // Build lead/deal name summary for notification
      const leadNames = (updated.linkedLeads || []).map(l => l.leadName).filter(Boolean);
      const dealNames = (updated.linkedDeals || []).map(d => d.dealName || d.dealTitle).filter(Boolean);
      const parts = [];
      if (leadNames.length > 0) parts.push(`Leads: ${leadNames.slice(0, 3).join(", ")}${leadNames.length > 3 ? ` +${leadNames.length - 3} more` : ""}`);
      if (dealNames.length > 0) parts.push(`Deals: ${dealNames.slice(0, 3).join(", ")}${dealNames.length > 3 ? ` +${dealNames.length - 3} more` : ""}`);
      const detailSuffix = parts.length > 0 ? ` (${parts.join(" | ")})` : "";

      const adminName = `${req.user.firstName} ${req.user.lastName}`;
      const updDescSuffix = updated.description?.trim() ? ` Message from admin: "${updated.description.trim()}"` : "";
      await createNotification(Notification, {
        userId: updated.salesPerson._id,
        title: "Target Updated",
        message: `Admin ${adminName} updated your target${detailSuffix}.${updDescSuffix} Check My Targets for the latest details.`,
        type: "target",
        meta: { targetId: String(updated._id), targetUpdated: true },
      });

      res.status(200).json({ message: "Target updated", data: updated });
    } catch (err) {
      console.error("Error updating target:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: delete target
  deleteTarget: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied: Admins only" });
      }
      const { Target, User, Role } = getModels(req);
      const deleted = await Target.findByIdAndDelete(req.params.id);
      if (!deleted) return res.status(404).json({ message: "Target not found" });

      // Real-time: tell the sales person to instantly remove this card
      notifyUser(String(deleted.salesPerson), "target_deleted", { targetId: String(deleted._id) });
      notifyUser(String(deleted.salesPerson), "targets_refresh", {});
      try {
        const admins = await findAdmins(User, Role);
        admins.forEach(a => notifyUser(String(a._id), "targets_refresh", {}));
      } catch (_) {}

      res.status(200).json({ message: "Target deleted successfully" });
    } catch (err) {
      console.error("Error deleting target:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: summary stats for dashboard
  getDashboardStats: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied: Admins only" });
      }
      const models = getModels(req);
      const { Lead, Deal, CallLog, Activity } = models;

      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - now.getDay());

      const [
        totalLeads,
        convertedLeads,
        totalDeals,
        wonDeals,
        monthCalls,
        monthMeetings,
        weekCalls,
        weekMeetings,
      ] = await Promise.all([
        Lead.countDocuments({ createdAt: { $gte: monthStart } }),
        Lead.countDocuments({ status: "Converted", updatedAt: { $gte: monthStart } }),
        Deal.countDocuments({ createdAt: { $gte: monthStart } }),
        Deal.countDocuments({ stage: "Closed Won", updatedAt: { $gte: monthStart } }),
        CallLog.countDocuments({ userId: { $exists: true }, createdAt: { $gte: monthStart } }),
        Activity.countDocuments({ activityCategory: "Meeting", startDate: { $gte: monthStart } }),
        CallLog.countDocuments({ userId: { $exists: true }, createdAt: { $gte: weekStart } }),
        Activity.countDocuments({ activityCategory: "Meeting", startDate: { $gte: weekStart } }),
      ]);

      res.status(200).json({
        monthly: {
          totalLeads,
          convertedLeads,
          leadToDealRate: totalLeads > 0 ? Math.round((convertedLeads / totalLeads) * 100) : 0,
          totalDeals,
          wonDeals,
          calls: monthCalls,
          meetings: monthMeetings,
        },
        weekly: {
          calls: weekCalls,
          meetings: weekMeetings,
        },
      });
    } catch (err) {
      console.error("Error fetching dashboard stats:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Sales: add a note to their target (visible to admin)
  addNote: async (req, res) => {
    try {
      const { Target, Notification, User, Role } = getModels(req);
      const { text } = req.body;
      if (!text?.trim()) return res.status(400).json({ message: "Note text is required" });

      const target = await Target.findById(req.params.id);
      if (!target) return res.status(404).json({ message: "Target not found" });

      // Only the assigned sales person can add notes
      if (String(target.salesPerson) !== String(req.user._id) && req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied" });
      }

      target.notes.push({ text: text.trim(), addedBy: req.user._id, addedAt: new Date() });
      await target.save();

      // Notify all admins
      const adminRole = await Role.findOne({ name: "Admin" });
      if (adminRole) {
        const admins = await User.find({ role: adminRole._id, status: "Active" }).select("_id");
        const salesName = `${req.user.firstName} ${req.user.lastName}`;
        await Promise.all(
          admins.map(admin =>
            createNotification(Notification, {
              userId: admin._id,
              title: "Note from Sales Person",
              message: `${salesName} added a note to their target: "${text.trim().substring(0, 80)}${text.length > 80 ? "..." : ""}"`,
              type: "target",
              meta: { targetId: String(target._id), noteAdded: true },
            })
          )
        );
      }

      res.status(200).json({ message: "Note added", notes: target.notes });
    } catch (err) {
      console.error("Error adding note:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Sales: flag a lead/deal with a reason note (visible to admin)
  addReasonNote: async (req, res) => {
    try {
      const { Target, Notification, User, Role } = getModels(req);
      const { itemType, itemId, itemName, note, companyName, phoneNumber, email, value, currency, stageOrStatus } = req.body;
      if (!note?.trim()) return res.status(400).json({ message: "Note is required" });
      if (!["lead", "deal"].includes(itemType)) return res.status(400).json({ message: "itemType must be lead or deal" });

      const target = await Target.findById(req.params.id);
      if (!target) return res.status(404).json({ message: "Target not found" });
      if (String(target.salesPerson) !== String(req.user._id) && req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied" });
      }

      target.reasonNotes.push({
        itemType,
        itemId,
        itemName,
        note: note.trim(),
        addedBy: req.user._id,
        addedAt: new Date(),
        status: "pending",
        companyName: companyName || "",
        phoneNumber: phoneNumber || "",
        email: email || "",
        value: value ? String(value) : "",
        currency: currency || "",
        stageOrStatus: stageOrStatus || "",
      });
      await target.save();

      // Notify all admins
      const adminRole = await Role.findOne({ name: "Admin" });
      if (adminRole) {
        const admins = await User.find({ role: adminRole._id, status: "Active" }).select("_id");
        const salesName = `${req.user.firstName} ${req.user.lastName}`;
        await Promise.all(
          admins.map(admin =>
            createNotification(Notification, {
              userId: admin._id,
              title: "Reason Note from Sales Person",
              message: `${salesName} reported an issue with ${itemType} "${itemName}": "${note.trim().substring(0, 100)}${note.length > 100 ? "..." : ""}"`,
              type: "reason_note",
              meta: { targetId: String(target._id), itemType, itemId: String(itemId), itemName, reasonNote: true },
            })
          )
        );
        // Socket notify admins immediately
        admins.forEach(a => notifyUser(String(a._id), "reason_note_received", {
          targetId: String(target._id), salesName, itemType, itemName, note: note.trim(),
        }));
      }

      res.status(200).json({ message: "Reason note sent to admin", reasonNotes: target.reasonNotes });
    } catch (err) {
      console.error("Error adding reason note:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: get all pending reason notes across all targets
  getAllReasonNotes: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") return res.status(403).json({ message: "Access denied" });
      const { Target } = getModels(req);
      const targets = await Target.find({ "reasonNotes.0": { $exists: true } })
        .populate("salesPerson", "firstName lastName email")
        .populate("reasonNotes.addedBy", "firstName lastName")
        .populate("reasonNotes.reassignedTo", "firstName lastName")
        .lean();

      const allNotes = [];
      for (const t of targets) {
        for (let i = 0; i < t.reasonNotes.length; i++) {
          allNotes.push({ ...t.reasonNotes[i], noteIdx: i, targetId: t._id, salesPerson: t.salesPerson });
        }
      }
      allNotes.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
      res.status(200).json(allNotes);
    } catch (err) {
      console.error("Error fetching reason notes:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: reassign a lead or deal to another sales person (from reason note)
  reassignItem: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") return res.status(403).json({ message: "Access denied" });
      const { Target, Lead, Deal, Notification, User } = getModels(req);
      const { noteIdx } = req.params;
      const { reassignToUserId, adminNote, extendEndDate } = req.body;

      const target = await Target.findById(req.params.id).populate("salesPerson", "firstName lastName");
      if (!target) return res.status(404).json({ message: "Target not found" });

      const rn = target.reasonNotes[Number(noteIdx)];
      if (!rn) return res.status(404).json({ message: "Reason note not found" });

      const newUser = await User.findById(reassignToUserId).select("firstName lastName");
      if (!newUser) return res.status(404).json({ message: "User not found" });

      const isSamePerson = String(target.salesPerson._id) === String(reassignToUserId);
      const adminName = `${req.user.firstName} ${req.user.lastName}`;
      const oldSalesName = `${target.salesPerson?.firstName} ${target.salesPerson?.lastName}`;
      const motivationalQuotes = [
        "Every expert was once a beginner. This is your chance to shine!",
        "Hard work beats talent when talent doesn't work hard. Go get it!",
        "Success is not given, it's earned. Give it everything you've got!",
        "Champions aren't made in the gym. They are made from things they carry inside them. Go close this one!",
        "The harder you work for something, the greater you'll feel when you achieve it. You've got this!",
        "Believe you can and you're halfway there. Go make it happen!",
        "Don't watch the clock — do what it does. Keep going!",
      ];
      const quote = motivationalQuotes[Math.floor(Math.random() * motivationalQuotes.length)];

      if (isSamePerson) {
        // Same person — mark note as reactivated so the card becomes editable again
        target.reasonNotes[Number(noteIdx)].status = "reactivated";
        target.reasonNotes[Number(noteIdx)].resolvedAt = new Date();
        target.reasonNotes[Number(noteIdx)].reassignedTo = reassignToUserId;
        target.reasonNotes[Number(noteIdx)].reassignNote = adminNote || "";
        await target.save();

        await createNotification(Notification, {
          userId: target.salesPerson._id,
          title: `${rn.itemType === "lead" ? "Lead" : "Deal"} Still Yours — Keep Going!`,
          message: `Admin ${adminName} reviewed "${rn.itemName}" and kept it with you.${adminNote ? ` Note: ${adminNote}` : ""} ${quote}`,
          type: "target_reassign",
          meta: { targetId: String(target._id), itemType: rn.itemType, itemId: String(rn.itemId), itemName: rn.itemName, reactivated: true },
        });
        notifyUser(String(target.salesPerson._id), "item_reactivated", {
          itemType: rn.itemType, itemName: rn.itemName, itemId: String(rn.itemId), quote,
        });
      } else {
        // ── Different person ──────────────────────────────────────────────
        console.log("[reassignItem] DIFFERENT PERSON branch. reassignToUserId:", String(reassignToUserId));
        console.log("[reassignItem] itemType:", rn.itemType, "itemId:", String(rn.itemId), "itemName:", rn.itemName);

        // 1. Re-assign lead/deal ownership + remove from original target
        let sourceLeadId = null; // populated when deal is a converted-lead-deal
        if (rn.itemType === "lead") {
          await Lead.findByIdAndUpdate(rn.itemId, { assignTo: reassignToUserId });
          target.linkedLeads = target.linkedLeads.filter(id => String(id) !== String(rn.itemId));
        } else {
          await Deal.findByIdAndUpdate(rn.itemId, { assignedTo: reassignToUserId });
          target.linkedDeals = target.linkedDeals.filter(id => String(id) !== String(rn.itemId));
          // Also handle converted-lead-deals: the source lead sits in linkedLeads, not linkedDeals
          const dealDoc = await Deal.findById(rn.itemId).select("leadId").lean();
          if (dealDoc?.leadId) {
            sourceLeadId = String(dealDoc.leadId);
            target.linkedLeads = target.linkedLeads.filter(id => String(id) !== sourceLeadId);
            console.log("[reassignItem] Converted-lead-deal — removed source lead:", sourceLeadId);
          }
        }
        target.reasonNotes[Number(noteIdx)].status      = "resolved";
        target.reasonNotes[Number(noteIdx)].resolvedAt  = new Date();
        target.reasonNotes[Number(noteIdx)].reassignedTo = reassignToUserId;
        target.reasonNotes[Number(noteIdx)].reassignNote = adminNote || "";
        await target.save();
        console.log("[reassignItem] Original target saved — item removed.");

        // 2. Find or create a target for the new sales person
        const today = new Date();
        let receiverTarget = await Target.findOne({
          salesPerson: reassignToUserId,
          startDate:   { $lte: today },
          endDate:     { $gte: today },
        }).sort({ createdAt: -1 }).lean();

        if (!receiverTarget) {
          receiverTarget = await Target.findOne({ salesPerson: reassignToUserId })
            .sort({ createdAt: -1 }).lean();
        }

        console.log("[reassignItem] receiverTarget found?", receiverTarget ? `YES — id: ${receiverTarget._id}` : "NO — will create new");

        const resolvedEndDate = extendEndDate ? new Date(extendEndDate) : null;

        if (receiverTarget) {
          const updateOp = { $addToSet: {} };
          if (rn.itemType === "lead") updateOp.$addToSet.linkedLeads = rn.itemId;
          else updateOp.$addToSet.linkedDeals = rn.itemId;
          if (resolvedEndDate) updateOp.$set = { endDate: resolvedEndDate };
          await Target.findByIdAndUpdate(receiverTarget._id, updateOp);
          console.log("[reassignItem] Item added to existing target via $addToSet.", resolvedEndDate ? `EndDate extended to ${resolvedEndDate}` : "");
        } else {
          const createPayload = {
            salesPerson:    reassignToUserId,
            period:         target.period,
            startDate:      target.startDate,
            endDate:        resolvedEndDate || target.endDate,
            // Set targets to 0 — admin can update later; avoids showing "0/1" with no items
            targetLeads:    0,
            targetDeals:    0,
            targetCalls:    0,
            targetMeetings: 0,
            description:    `Assigned by admin — ${rn.itemType}: ${rn.itemName}`,
            createdBy:      req.user._id,
            linkedLeads:    rn.itemType === "lead" ? [rn.itemId] : [],
            linkedDeals:    rn.itemType === "deal" ? [rn.itemId] : [],
          };
          console.log("[reassignItem] Creating new target with payload:", JSON.stringify(createPayload));
          receiverTarget = await Target.create(createPayload);
          console.log("[reassignItem] New target created — id:", String(receiverTarget._id));
        }

        // 3. Notifications
        await createNotification(Notification, {
          userId: reassignToUserId,
          title:   `New ${rn.itemType === "lead" ? "Lead" : "Deal"} Assigned to You`,
          message: `Admin ${adminName} assigned "${rn.itemName}" to you. ${quote}`,
          type:    "target_reassign",
          meta:    { itemType: rn.itemType, itemId: String(rn.itemId), itemName: rn.itemName },
        });
        await createNotification(Notification, {
          userId:  target.salesPerson._id,
          title:   `${rn.itemType === "lead" ? "Lead" : "Deal"} Reassigned`,
          message: `Admin ${adminName} assigned "${rn.itemName}" to ${newUser.firstName} ${newUser.lastName}.${adminNote ? ` Note: ${adminNote}` : ""} You did well! ${quote}`,
          type:    "target_reassign",
          meta:    { itemType: rn.itemType, itemId: String(rn.itemId), itemName: rn.itemName, removed: true },
        });

        // 4. Real-time events
        notifyUser(String(reassignToUserId),      "item_reassigned",  { itemType: rn.itemType, itemName: rn.itemName, quote });
        notifyUser(String(reassignToUserId),      "targets_refresh",  {});
        notifyUser(String(target.salesPerson._id), "item_removed",    { itemType: rn.itemType, itemName: rn.itemName, itemId: String(rn.itemId), sourceLeadId, targetId: String(target._id) });
        notifyUser(String(target.salesPerson._id), "targets_refresh", {});

        // Notify all admins to refresh their view
        try {
          const { Role } = getModels(req);
          const admins = await findAdmins(User, Role);
          admins.forEach(a => notifyUser(String(a._id), "targets_refresh", {}));
        } catch (_) { /* non-critical */ }
      }

      res.status(200).json({ message: isSamePerson ? "Item reactivated for same sales person" : "Item reassigned successfully" });
    } catch (err) {
      console.error("Error reassigning item:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: delete a single reason note
  deleteReasonNote: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") return res.status(403).json({ message: "Access denied" });
      const { Target } = getModels(req);
      const target = await Target.findById(req.params.id);
      if (!target) return res.status(404).json({ message: "Target not found" });
      const idx = parseInt(req.params.noteIdx, 10);
      if (isNaN(idx) || idx < 0 || idx >= target.reasonNotes.length)
        return res.status(404).json({ message: "Note not found" });
      target.reasonNotes.splice(idx, 1);
      await target.save();
      res.status(200).json({ message: "Note deleted" });
    } catch (err) {
      console.error("Error deleting reason note:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: bulk delete reason notes
  bulkDeleteReasonNotes: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") return res.status(403).json({ message: "Access denied" });
      const { Target } = getModels(req);
      const { items } = req.body; // [{targetId, noteIdx}]
      if (!Array.isArray(items) || items.length === 0)
        return res.status(400).json({ message: "items array is required" });

      // Group by targetId and sort indices descending (to avoid shifting)
      const byTarget = {};
      for (const { targetId, noteIdx } of items) {
        if (!byTarget[targetId]) byTarget[targetId] = [];
        byTarget[targetId].push(parseInt(noteIdx, 10));
      }
      for (const [targetId, indices] of Object.entries(byTarget)) {
        const target = await Target.findById(targetId);
        if (!target) continue;
        const sorted = [...new Set(indices)].sort((a, b) => b - a);
        for (const idx of sorted) {
          if (idx >= 0 && idx < target.reasonNotes.length) target.reasonNotes.splice(idx, 1);
        }
        await target.save();
      }
      res.status(200).json({ message: "Notes deleted" });
    } catch (err) {
      console.error("Error bulk deleting reason notes:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },
};
