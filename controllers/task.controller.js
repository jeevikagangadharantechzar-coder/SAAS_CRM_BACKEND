import mongoose from "mongoose";
import { getTenantModels } from "../models/tenant/index.js";
import { notifyUser } from "../realtime/socket.js";
import {
  createNotification,
  findAdmins,
  broadcastTasksRefresh,
  LEAD_DEAL_POPULATE,
  attachLinkedItemBadge,
  attachLinkedArrays,
  buildLinkedMeta,
  attachConvertedDealJourney,
} from "../services/taskNotificationService.js";
import { getBulkLinkage } from "../services/linkageService.js";
import { sendDueToday, sendItemDueToday, getAdminIds } from "../cron/taskCron.js";
import { computeTaskProgress } from "../services/taskProgressService.js";

const getModels = (req) => getTenantModels(req.tenantDB);

async function computeActuals(models, userId, startDate, endDate, linkedLeadIds = null, linkedDealIds = null, targetLeadsGoal = 0, targetDealsGoal = 0, reportedCallsCount = 0, reportedMeetingsCount = 0, hadSpecificLeads = false, hadSpecificDeals = false) {
  const { Lead, Deal, CallLog, Activity } = models;

  const start = new Date(startDate);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  const leadsConvertedQuery = linkedLeadIds && linkedLeadIds.length > 0
    ? Deal.distinct("leadId", { 
        leadId: { $in: linkedLeadIds },
        $or: [
          { convertedBy: userId },
          { convertedBy: null, assignedTo: userId },
          { convertedBy: { $exists: false }, assignedTo: userId }
        ]
      }).then(ids => ids.length)
    : targetLeadsGoal > 0 && !hadSpecificLeads
      ? Lead.countDocuments({ assignTo: userId, status: "Converted", updatedAt: { $gte: start, $lte: end } })
      : Promise.resolve(0);

  const dealsWonQuery = linkedDealIds && linkedDealIds.length > 0
    ? Deal.countDocuments({ _id: { $in: linkedDealIds }, stage: "Closed Won", wonBy: userId })
    : targetDealsGoal > 0 && !hadSpecificDeals
      ? Deal.countDocuments({ assignedTo: userId, stage: "Closed Won", wonAt: { $gte: start, $lte: end } })
      : Promise.resolve(0);

  const leadDealWonQuery = linkedLeadIds && linkedLeadIds.length > 0
    ? Deal.distinct("leadId", { 
        leadId: { $in: linkedLeadIds }, 
        stage: "Closed Won",
        wonBy: userId
      }).then(ids => ids.length)
    : targetLeadsGoal > 0 && !hadSpecificLeads
      ? Deal.countDocuments({ assignedTo: userId, leadId: { $ne: null }, stage: "Closed Won", wonAt: { $gte: start, $lte: end } })
      : Promise.resolve(0);

  const dealsLostQuery = (linkedDealIds && linkedDealIds.length > 0) || (linkedLeadIds && linkedLeadIds.length > 0)
    ? Deal.countDocuments({ 
        $or: [
          ...(linkedDealIds?.length ? [{ _id: { $in: linkedDealIds } }] : []),
          ...(linkedLeadIds?.length ? [{ leadId: { $in: linkedLeadIds } }] : [])
        ],
        stage: "Closed Lost" 
      })
    : targetDealsGoal > 0 || targetLeadsGoal > 0
      ? Deal.countDocuments({ assignedTo: userId, stage: "Closed Lost", updatedAt: { $gte: start, $lte: end } })
      : Promise.resolve(0);

  const [leadsConverted, dealsWon, leadDealWon, dealsLost] = await Promise.all([
    leadsConvertedQuery,
    dealsWonQuery,
    leadDealWonQuery,
    dealsLostQuery
  ]);

  return { leadsConverted, dealsWon, calls: reportedCallsCount, meetings: reportedMeetingsCount, leadDealWon, dealsLost };
}

export default {
  getLinkedTasks: async (req, res) => {
    try {
      const { itemType, itemId } = req.params;
      const { Task, Deal } = getModels(req);
      
      const query = { archived: false };
      
      if (itemType === "lead") {
        query.$or = [{ leadRef: itemId }, { leadRefs: itemId }];
      } else if (itemType === "deal") {
        query.$or = [{ dealRef: itemId }, { dealRefs: itemId }];
      } else {
        return res.status(400).json({ message: "Invalid itemType" });
      }

      if (req.user.role?.name !== "Admin") {
        query.assignedTo = req.user.id;
      }

      let tasks = await Task.find(query).populate(LEAD_DEAL_POPULATE).lean();
      tasks = tasks.map(attachLinkedArrays).map(attachLinkedItemBadge);
      tasks = await attachConvertedDealJourney(Deal, tasks);

      res.status(200).json(tasks);
    } catch (error) {
      console.error("Error in getLinkedTasks:", error);
      res.status(500).json({ message: "Server error while fetching linked tasks" });
    }
  },

  // Admin: get all tasks; Sales: get their own assigned tasks
  getTasks: async (req, res) => {
    try {
      const { Task, Deal } = getModels(req);
      const isAdmin = req.user.role?.name === "Admin";

      // No approval gate — a task is done once marked Completed. Both roles
      // only filter out `archived` (a real, explicit delete). A task whose
      // linked deal was closed Won by Admin (rather than the assignee) stays
      // fully visible on the assignee's own list too — same task, same
      // journey, Admin and assignee just see the identical record.
      const query = isAdmin
        ? { archived: { $ne: true } }
        : { assignedTo: req.user._id, archived: { $ne: true } };

      const rawTasks = await Task.find(query)
        .populate(LEAD_DEAL_POPULATE)
        .sort({ createdAt: -1 })
        .lean();

      // A task can still be linked via leadRef (converted to a deal
      // elsewhere) — only carries its deal's stage/wonBy here, not on
      // task.dealRef, so resolve it for every task's Stage Journey view.
      await attachConvertedDealJourney(Deal, rawTasks);

      const tasksToReturn = [];
      for (const t of rawTasks) {
        attachLinkedArrays(t);
        
        if (t.status !== "Completed" && t.status !== "Rejected") {
          const totalItems = (t.leadRefs?.length || 0) + (t.dealRefs?.length || 0);
          if (totalItems > 0) {
            let completedItems = 0;
            (t.dealRefs || []).forEach(d => { if (d && d.stage === "Closed Won") completedItems++; });
            (t.leadRefs || []).forEach(l => { if (l && l.status === "Converted") completedItems++; });
            const overall = Math.round((completedItems / totalItems) * 100);

            if (t.status === "In Hold") {
              if (t.holdSnapshotProgress == null) {
                t.holdSnapshotProgress = overall;
                await Task.findByIdAndUpdate(t._id, { holdSnapshotProgress: overall });
              } else if (overall > t.holdSnapshotProgress) {
                if (overall >= 100) {
                  t.status = "Completed";
                  t.completedAt = new Date();
                  t.approvedByAdmin = true;
                  await Task.findByIdAndUpdate(t._id, { 
                    status: "Completed",
                    completedAt: t.completedAt,
                    approvedByAdmin: true,
                    holdSnapshotProgress: null
                  });
                } else {
                  t.status = "In Progress";
                  await Task.findByIdAndUpdate(t._id, { status: "In Progress", holdSnapshotProgress: null });
                }
              }
            } else {
              if (overall >= 100) {
                t.status = "Completed";
                t.completedAt = new Date();
                t.approvedByAdmin = true; // Auto-approve just like when manually marked completed
                await Task.findByIdAndUpdate(t._id, { 
                  status: "Completed",
                  completedAt: t.completedAt,
                  approvedByAdmin: true
                });
              } else if (overall > 0 && (t.status === "Pending")) {
                t.status = "In Progress";
                await Task.findByIdAndUpdate(t._id, { status: "In Progress" });
              } else if (overall === 0 && t.status === "In Progress") {
                t.status = "Pending";
                await Task.findByIdAndUpdate(t._id, { status: "Pending" });
              }
            }
          }
        }
        
        tasksToReturn.push(attachLinkedItemBadge(t));
      }

      res.status(200).json(tasksToReturn);
    } catch (err) {
      console.error("Error fetching tasks:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin only: create task, assign to sales person, notify them
  createTask: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied: Admins only" });
      }
      const { Task, Notification, User, Role } = getModels(req);
      const { title, description, priority, dueDate, assignedTo, leadRef, dealRef, leadRefs, dealRefs, callsMade, meetingsDone } = req.body;
      const adminName = `${req.user.firstName} ${req.user.lastName}`;

      // Accept either the new array shape (from the multi-select picker) or
      // a bare legacy scalar — leadRef/dealRef are then derived as the
      // array's last (most-recently-linked) item, so every existing reader
      // of the singular fields keeps working unchanged.
      const initLeadRefs = (Array.isArray(leadRefs) && leadRefs.length ? leadRefs : (leadRef ? [leadRef] : [])).filter(Boolean);
      const initDealRefs = (Array.isArray(dealRefs) && dealRefs.length ? dealRefs : (dealRef ? [dealRef] : [])).filter(Boolean);

      const task = await Task.create({
        title,
        description,
        priority,
        dueDate,
        assignedTo,
        leadRef: initLeadRefs.length ? initLeadRefs[initLeadRefs.length - 1] : null,
        dealRef: initDealRefs.length ? initDealRefs[initDealRefs.length - 1] : null,
        leadRefs: initLeadRefs,
        dealRefs: initDealRefs,
        callsMade: callsMade || 0,
        meetingsDone: meetingsDone || 0,
        createdBy: req.user._id,
        status: "Pending",
        history: [
          { event: "Created", detail: `Task created by Admin ${adminName}`, by: req.user._id, at: new Date() },
          { event: "Assigned", detail: `Assigned to sales person by Admin ${adminName}`, by: req.user._id, at: new Date() },
        ],
      });

      const populated = await task.populate([
        { path: "assignedTo", select: "firstName lastName email" },
        { path: "createdBy", select: "firstName lastName email" },
        { path: "leadRef", select: "leadName companyName phoneNumber email" },
        { path: "dealRef", select: "dealName dealTitle companyName phoneNumber email" },
      ]);

      // Notify assigned sales person
      await createNotification(Notification, {
        userId: assignedTo,
        title: "New Task Assigned",
        message: `Admin ${adminName} assigned you a new task: "${title}"`,
        type: "task",
        meta: { taskId: String(task._id), taskAssigned: true, ...buildLinkedMeta(populated) },
      });
      await broadcastTasksRefresh(User, Role, [assignedTo]);

      // A task created with today's due date shouldn't have to wait for the
      // next 15-min cron tick to get its "due today" notification — fire it
      // immediately. sendDueToday already stamps dueTodaySentAt, so the cron
      // correctly skips re-notifying later. Never blocks task creation.
      if (new Date(dueDate).toDateString() === new Date().toDateString()) {
        try {
          const adminIds = await getAdminIds(User, Role);
          await sendDueToday(populated, adminIds, Task, Notification, new Date());
        } catch (e) {
          console.error("Immediate due-today notification error:", e.message);
        }
      }

      res.status(201).json({ message: "Task created successfully", data: populated });
    } catch (err) {
      console.error("Error creating task:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Update task: sales can update status + completionNotes; admin can update all fields
  updateTask: async (req, res) => {
    try {
      const { Task, Notification, User, Role, Deal } = getModels(req);
      const task = await Task.findById(req.params.id)
        .populate("assignedTo", "firstName lastName email")
        .populate("createdBy", "firstName lastName email");

      if (!task) return res.status(404).json({ message: "Task not found" });

      const isAdmin = req.user.role?.name === "Admin";
      const isAssigned = task.assignedTo._id.toString() === req.user._id.toString();

      if (!isAdmin && !isAssigned) {
        return res.status(403).json({ message: "Access denied" });
      }

      const wasCompleted = task.status === "Completed";
      const nowCompleting = req.body.status === "Completed" && !wasCompleted;
      const actorName = `${req.user.firstName} ${req.user.lastName}`;

      // Backward-compat-derived arrays as they stand BEFORE this edit.
      const currentLeadRefs = (task.leadRefs && task.leadRefs.length) ? task.leadRefs.map(String) : (task.leadRef ? [String(task.leadRef)] : []);
      const currentDealRefs = (task.dealRefs && task.dealRefs.length) ? task.dealRefs.map(String) : (task.dealRef ? [String(task.dealRef)] : []);

      // Narrow exception to the sales-permitted field list: the assignee can
      // dismiss (unlink) ONE Closed-Won deal from their task's linked list —
      // their own trophy to keep or clear once they've seen it, regardless
      // of whether they closed it themselves or Admin closed it on their
      // behalf (both stay visible on their list; this is just their own
      // manual "I've seen it" cleanup, not a hide-from-them action). `dealId`
      // defaults to the current primary so older frontend calls that only
      // send `{dismissWonDeal:true}` keep working.
      let dismissingOwnWonDeal = false;
      let dismissDealId = null;
      if (!isAdmin && req.body.dismissWonDeal) {
        dismissDealId = req.body.dealId ? String(req.body.dealId) : (currentDealRefs[currentDealRefs.length - 1] || null);
        if (dismissDealId) {
          const linkedDeal = await Deal.findById(dismissDealId).select("stage");
          if (linkedDeal?.stage === "Closed Won") dismissingOwnWonDeal = true;
        }
      }

      // Admin can change linked leads/deals two ways:
      //  - a full array (`leadRefs`/`dealRefs`) from the multi-select picker's
      //    Save — a plain replace of whatever the admin left checked (checked
      //    items are pre-hydrated from the existing links, so nothing is lost
      //    unless explicitly unchecked);
      //  - a single `removeLeadRef`/`removeDealRef` id from a card's own
      //    "Unlink" button — filters just that one id out.
      // A bare `leadRef`/`dealRef` scalar is never honored here — that raw
      // overwrite shape was exactly the "picking a new one silently drops
      // the old one" bug.
      let newLeadRefs = null;
      let newDealRefs = null;
      if (isAdmin) {
        if (Array.isArray(req.body.leadRefs)) {
          newLeadRefs = [...new Set(req.body.leadRefs.filter(Boolean).map(String))];
        } else if (req.body.removeLeadRef) {
          newLeadRefs = currentLeadRefs.filter((id) => id !== String(req.body.removeLeadRef));
        }
        if (Array.isArray(req.body.dealRefs)) {
          newDealRefs = [...new Set(req.body.dealRefs.filter(Boolean).map(String))];
        } else if (req.body.removeDealRef) {
          newDealRefs = currentDealRefs.filter((id) => id !== String(req.body.removeDealRef));
        }
      }
      if (dismissingOwnWonDeal) {
        newDealRefs = currentDealRefs.filter((id) => id !== dismissDealId);
      }

      // Build update payload — spread everything else the admin/sales sent,
      // but the link fields are always computed explicitly above, never
      // taken raw from req.body.
      const updatePayload = isAdmin
        ? { ...req.body }
        : { 
            status: req.body.status, 
            completionNotes: req.body.completionNotes,
            inProcessNote: req.body.inProcessNote,
          };

      // Handle Rejection Request for Salespeople
      if (!isAdmin && req.body.status === "Rejected") {
        updatePayload.status = task.status; // Revert status, wait for admin approval
        updatePayload.rejectionRequested = true;
        updatePayload.rejectionReason = req.body.rejectionReason || "";
      }
      
      // Handle Hold Request for Salespeople
      if (!isAdmin && req.body.status === "In Hold") {
        updatePayload.status = task.status; // Revert status, wait for admin approval
        updatePayload.holdRequested = true;
        updatePayload.holdReason = req.body.holdReason || "";
        updatePayload.holdRequestedAt = new Date();
      }
      delete updatePayload.leadRef;
      delete updatePayload.dealRef;
      delete updatePayload.leadRefs;
      delete updatePayload.dealRefs;
      delete updatePayload.removeLeadRef;
      delete updatePayload.removeDealRef;
      delete updatePayload.dismissWonDeal;
      delete updatePayload.dealId;
      delete updatePayload.leadDueDates;
      delete updatePayload.dealDueDates;

      if (newLeadRefs) {
        updatePayload.leadRefs = newLeadRefs;
        updatePayload.leadRef = newLeadRefs.length ? newLeadRefs[newLeadRefs.length - 1] : null;
      }
      if (newDealRefs) {
        updatePayload.dealRefs = newDealRefs;
        updatePayload.dealRef = newDealRefs.length ? newDealRefs[newDealRefs.length - 1] : null;
      }

      if (nowCompleting) {
        updatePayload.completedAt = new Date();
        // No separate admin-approval step — marking Completed finalizes the task.
        updatePayload.approvedByAdmin = true;
      }

      // Changing the due date should restart the reminder cycle, otherwise the
      // cron thinks it already notified for this task and stays silent.
      if (isAdmin && req.body.dueDate && new Date(req.body.dueDate).toDateString() !== new Date(task.dueDate).toDateString()) {
        updatePayload.reminderSentAt = null;
        updatePayload.dueTodaySentAt = null;
      }

      // Did the admin add/remove any linked lead or deal on this edit?
      const sortedEq = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
      const addedLeadIds = newLeadRefs ? newLeadRefs.filter((id) => !currentLeadRefs.includes(id)) : [];
      const addedDealIds = newDealRefs ? newDealRefs.filter((id) => !currentDealRefs.includes(id)) : [];
      const linkedItemChanged = isAdmin && (
        (newLeadRefs && !sortedEq(newLeadRefs, currentLeadRefs)) ||
        (newDealRefs && !sortedEq(newDealRefs, currentDealRefs))
      );

      // If the task was already completed and the admin adds new leads/deals, 
      // we create a new task ("Continuation of...") instead of modifying the completed one.
      if (wasCompleted && isAdmin && (addedLeadIds.length || addedDealIds.length)) {
        const providedLeadDates = req.body.leadDueDates || {};
        const providedDealDates = req.body.dealDueDates || {};
        const missingLead = addedLeadIds.filter((id) => !providedLeadDates[id]);
        const missingDeal = addedDealIds.filter((id) => !providedDealDates[id]);
        if (missingLead.length || missingDeal.length) {
          return res.status(400).json({ message: "Please set a due date for each newly linked lead/deal." });
        }

        const newTask = await Task.create({
          title: `Continuation of ${task.title}`,
          description: task.description,
          priority: task.priority,
          dueDate: req.body.dueDate || task.dueDate,
          assignedTo: task.assignedTo._id,
          createdBy: req.user._id,
          status: "Pending",
          leadRefs: addedLeadIds,
          dealRefs: addedDealIds,
          leadRef: addedLeadIds.length ? addedLeadIds[addedLeadIds.length - 1] : null,
          dealRef: addedDealIds.length ? addedDealIds[addedDealIds.length - 1] : null,
          leadDueDates: providedLeadDates,
          dealDueDates: providedDealDates,
          history: [
            { event: "Created", detail: `Created as a continuation of completed task "${task.title}"`, by: req.user._id, at: new Date() }
          ],
        });

        const adminName = `${req.user.firstName} ${req.user.lastName}`;
        await createNotification(Notification, {
          userId: task.assignedTo._id,
          title: "New Task Assigned (Continuation)",
          message: `Admin ${adminName} assigned you a new task: "${newTask.title}"`,
          type: "task",
          meta: { taskId: String(newTask._id), taskAssigned: true },
        });
        await broadcastTasksRefresh(User, Role, [task.assignedTo._id]);

        return res.status(200).json({ message: "Task was already completed, so a new Continuation task was created.", data: task });
      }

      // Each lead/deal newly added to the task on THIS edit (not one that was
      // already linked) must come with its own due date, picked inline in the
      // linking panel — existing links are left untouched, their stored due
      // dates (if any) just carry over unchanged in the merge below.
      if (isAdmin && (addedLeadIds.length || addedDealIds.length)) {
        const providedLeadDates = req.body.leadDueDates || {};
        const providedDealDates = req.body.dealDueDates || {};
        const missingLead = addedLeadIds.filter((id) => !providedLeadDates[id]);
        const missingDeal = addedDealIds.filter((id) => !providedDealDates[id]);
        if (missingLead.length || missingDeal.length) {
          return res.status(400).json({ message: "Please set a due date for each newly linked lead/deal." });
        }
      }
      if (newLeadRefs) {
        const existingLeadDueDates = task.leadDueDates ? Object.fromEntries(task.leadDueDates) : {};
        const providedLeadDates = req.body.leadDueDates || {};
        const mergedLeadDueDates = {};
        newLeadRefs.forEach((id) => {
          const merged = providedLeadDates[id] || existingLeadDueDates[id];
          if (merged) mergedLeadDueDates[id] = merged;
        });
        updatePayload.leadDueDates = mergedLeadDueDates;
      }
      if (newDealRefs) {
        const existingDealDueDates = task.dealDueDates ? Object.fromEntries(task.dealDueDates) : {};
        const providedDealDates = req.body.dealDueDates || {};
        const mergedDealDueDates = {};
        newDealRefs.forEach((id) => {
          const merged = providedDealDates[id] || existingDealDueDates[id];
          if (merged) mergedDealDueDates[id] = merged;
        });
        updatePayload.dealDueDates = mergedDealDueDates;
      }

      // Defensive safeguard: a task should never end up actively holding a
      // deal that's already Closed Won (the deal-linking picker already
      // hides such deals, but this covers any other path that could still
      // link one) — archive it immediately instead of leaving a stale,
      // already-resolved deal sitting in an "active" task. Checks every
      // newly-added deal id, not just a single before/after scalar.
      let linkingToAlreadyWonDeal = false;
      for (const id of addedDealIds) {
        const linkedDeal = await Deal.findById(id).select("stage");
        if (linkedDeal?.stage === "Closed Won") { linkingToAlreadyWonDeal = true; break; }
      }
      if (linkingToAlreadyWonDeal) updatePayload.archived = true;

      const historyPush = [];
      if (req.body.status && req.body.status !== task.status) {
        historyPush.push({ event: "StatusChanged", detail: `Status changed to "${req.body.status}" by ${isAdmin ? "Admin " : ""}${actorName}`, by: req.user._id, at: new Date() });
      }
      if (req.body.completionNotes !== undefined && req.body.completionNotes !== task.completionNotes && req.body.completionNotes) {
        historyPush.push({ event: "NoteAdded", detail: req.body.completionNotes, by: req.user._id, at: new Date() });
      }
      if (linkedItemChanged) {
        historyPush.push({ event: "LinkedItemChanged", detail: `Linked lead/deal updated by Admin ${actorName}`, by: req.user._id, at: new Date() });
      }
      if (linkingToAlreadyWonDeal) {
        historyPush.push({ event: "StatusChanged", detail: "Linked deal is already Closed Won — task auto-archived", by: req.user._id, at: new Date() });
      }
      if (dismissingOwnWonDeal) {
        historyPush.push({ event: "LinkedItemChanged", detail: `${actorName} dismissed the Closed Won deal card from this task`, by: req.user._id, at: new Date() });
      }
      if (historyPush.length) updatePayload.$push = { history: { $each: historyPush } };

      if (!isAdmin && req.body.status === "Rejected") {
        updatePayload.$push = updatePayload.$push || { history: { $each: [] } };
        updatePayload.$push.history.$each.push({ event: "RejectionRequested", detail: `Salesperson requested rejection. Reason: ${req.body.rejectionReason || "None given"}`, by: req.user._id, at: new Date() });
      }

      if (!isAdmin && req.body.status === "In Hold") {
        updatePayload.$push = updatePayload.$push || { history: { $each: [] } };
        updatePayload.$push.history.$each.push({ event: "HoldRequested", detail: `Salesperson requested to place task on hold. Reason: ${req.body.holdReason || "None given"}`, by: req.user._id, at: new Date() });
      }

      const updated = await Task.findByIdAndUpdate(req.params.id, updatePayload, {
        new: true,
        runValidators: true,
      }).populate(LEAD_DEAL_POPULATE);
      const updatedObj = updated.toObject();
      await attachConvertedDealJourney(Deal, [updatedObj]);
      const updatedLean = attachLinkedArrays(attachLinkedItemBadge(updatedObj));

      // A newly-linked lead/deal whose own due date is today shouldn't have
      // to wait for the next 15-min cron tick to get its reminder — same
      // immediate-fire pattern as a brand-new task's own due date in
      // createTask above. Never blocks the update response.
      if (addedLeadIds.length || addedDealIds.length) {
        try {
          const todayStr = new Date().toDateString();
          const leadNameById = new Map((updated.leadRefs || []).map((l) => [String(l._id), l.leadName]));
          const dealNameById = new Map((updated.dealRefs || []).map((d) => [String(d._id), d.dealName || d.dealTitle]));
          const itemAdminIds = await getAdminIds(User, Role);
          for (const id of addedLeadIds) {
            const due = updatePayload.leadDueDates?.[id];
            if (due && new Date(due).toDateString() === todayStr) {
              await sendItemDueToday(updatedObj, id, false, leadNameById.get(id) || "a linked lead", itemAdminIds, Task, Notification, new Date(), "leadDueTodaySentAt");
            }
          }
          for (const id of addedDealIds) {
            const due = updatePayload.dealDueDates?.[id];
            if (due && new Date(due).toDateString() === todayStr) {
              await sendItemDueToday(updatedObj, id, true, dealNameById.get(id) || "a linked deal", itemAdminIds, Task, Notification, new Date(), "dealDueTodaySentAt");
            }
          }
        } catch (e) {
          console.error("Immediate lead/deal due-today notification error:", e.message);
        }
      }

      // Admin attached/changed a linked lead or deal → notify the assigned
      // sales person (shows in their sidebar bell + Notifications & Reminders tab).
      if (linkedItemChanged) {
        const leadName = updated.leadRef?.leadName || null;
        const dealName = updated.dealRef?.dealName || updated.dealRef?.dealTitle || null;
        const linkedText = leadName ? `lead "${leadName}"` : dealName ? `deal "${dealName}"` : "no lead/deal";
        await createNotification(Notification, {
          userId: updated.assignedTo._id,
          title: "Task Updated",
          message: `Admin ${actorName} updated task "${task.title}" — now linked to ${linkedText}.`,
          type: "task",
          meta: { taskId: String(task._id), taskUpdated: true, ...buildLinkedMeta(updated) },
        });
      }

      // When sales marks as completed → notify all admins
      if (nowCompleting && !isAdmin) {
        const admins = await findAdmins(User, Role);
        const salesName = `${req.user.firstName} ${req.user.lastName}`;
        const notes = req.body.completionNotes || "";
        const message = notes
          ? `${salesName} completed task "${task.title}" — Notes: ${notes}`
          : `${salesName} completed task "${task.title}"`;

        for (const admin of admins) {
          await createNotification(Notification, {
            userId: admin._id,
            title: "Task Completed",
            message,
            type: "task",
            meta: { taskId: String(task._id), taskCompleted: true, completionNotes: notes, ...buildLinkedMeta(updated) },
          });
        }

        // Celebrate with the sales person too — no more waiting on admin approval.
        await createNotification(Notification, {
          userId: req.user._id,
          title: "Task Completed",
          message: "You successfully completed this task! Thank you for the great work!",
          type: "task",
          meta: { taskId: String(task._id), taskCompletedBySelf: true, ...buildLinkedMeta(updated) },
        });
      }

      // When sales adds notes without completing → notify admins
      const notesAdded =
        !isAdmin &&
        !nowCompleting &&
        req.body.completionNotes &&
        req.body.completionNotes !== task.completionNotes;

      // When sales requests rejection → notify admins
      const rejectionRequested = !isAdmin && req.body.status === "Rejected";

      // When sales requests hold → notify admins
      const holdRequested = !isAdmin && req.body.status === "In Hold";

      if (notesAdded || rejectionRequested || holdRequested) {
        const admins = await findAdmins(User, Role);
        const salesName = `${req.user.firstName} ${req.user.lastName}`;
        for (const admin of admins) {
          if (notesAdded) {
            await createNotification(Notification, {
              userId: admin._id,
              title: "Task Note Added",
              message: `${salesName} added a note on task "${task.title}": ${req.body.completionNotes}`,
              type: "task",
              meta: { taskId: String(task._id), taskNoteAdded: true, completionNotes: req.body.completionNotes, ...buildLinkedMeta(updated) },
            });
          }
          if (rejectionRequested) {
            await createNotification(Notification, {
              userId: admin._id,
              title: "Task Rejection Requested",
              message: `${salesName} requested to reject task "${task.title}". Reason: ${req.body.rejectionReason}`,
              type: "task",
              meta: { taskId: String(task._id), taskRejectionRequested: true, rejectionReason: req.body.rejectionReason, ...buildLinkedMeta(updated) },
            });
          }
          if (holdRequested) {
            await createNotification(Notification, {
              userId: admin._id,
              title: "Task Hold Requested",
              message: `${salesName} requested to place task "${task.title}" on hold. Reason: ${req.body.holdReason}`,
              type: "task",
              meta: { taskId: String(task._id), taskHoldRequested: true, holdReason: req.body.holdReason, ...buildLinkedMeta(updated) },
            });
          }
        }
      }

      await broadcastTasksRefresh(User, Role, [task.assignedTo._id, updated.assignedTo?._id]);

      res.status(200).json({ message: "Task updated", data: updatedLean });
    } catch (err) {
      console.error("Error updating task:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: approve a completed task — removes it from sales person's view
  approveTask: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied: Admins only" });
      }
      const { Task, Notification, User, Role } = getModels(req);
      const task = await Task.findById(req.params.id)
        .populate("leadRef", "leadName companyName phoneNumber email")
        .populate("dealRef", "dealName dealTitle companyName phoneNumber email");
      if (!task) return res.status(404).json({ message: "Task not found" });

      const adminName = `${req.user.firstName} ${req.user.lastName}`;
      const updated = await Task.findByIdAndUpdate(
        req.params.id,
        {
          approvedByAdmin: true,
          $push: { history: { event: "Approved", detail: `Approved by Admin ${adminName}`, by: req.user._id, at: new Date() } },
        },
        { new: true }
      ).populate("assignedTo", "firstName lastName email");

      // Build rich notification message
      const now = new Date();
      const dateStr = now.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
      const timeStr = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });

      const leadName = task.leadRef?.leadName
        ? `${task.leadRef.leadName}${task.leadRef.companyName ? ` (${task.leadRef.companyName})` : ""}`
        : null;
      const dealName = task.dealRef?.dealName || task.dealRef?.dealTitle || null;

      let linkedInfo = "";
      if (leadName) linkedInfo = ` | Lead: ${leadName}`;
      else if (dealName) linkedInfo = ` | Deal: ${dealName}`;

      const message = `Admin ${adminName} approved your completed task: "${task.title}"${linkedInfo} — Approved on ${dateStr} at ${timeStr}`;

      await createNotification(Notification, {
        userId: task.assignedTo,
        title: "Task Approved",
        message,
        type: "task",
        meta: {
          taskId: String(task._id),
          taskApproved: true,
          taskTitle: task.title,
          adminName,
          leadName: leadName || null,
          dealName: dealName || null,
          approvedDate: dateStr,
          approvedTime: timeStr,
          ...buildLinkedMeta(task),
        },
      });

      await broadcastTasksRefresh(User, Role, [task.assignedTo]);

      res.status(200).json({ message: "Task approved", data: updated });
    } catch (err) {
      console.error("Error approving task:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: approve or deny a rejection request
  approveRejection: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied: Admins only" });
      }
      const { Task, Notification, User, Role } = getModels(req);
      const { action } = req.body; // "approve" or "deny"
      const task = await Task.findById(req.params.id);
      if (!task) return res.status(404).json({ message: "Task not found" });

      const adminName = `${req.user.firstName} ${req.user.lastName}`;
      let updatePayload = {};
      let message = "";

      if (action === "approve") {
        updatePayload = {
          status: "Rejected",
          rejectionRequested: false,
          rejectionApprovedAt: new Date(),
          $push: { history: { event: "RejectionApproved", detail: `Rejection approved by Admin ${adminName}`, by: req.user._id, at: new Date() } },
        };
        message = `Admin ${adminName} approved your request to reject task "${task.title}".`;
      } else {
        updatePayload = {
          rejectionRequested: false,
          rejectionReason: "",
          $push: { history: { event: "RejectionDenied", detail: `Rejection denied by Admin ${adminName}`, by: req.user._id, at: new Date() } },
        };
        message = `Admin ${adminName} denied your request to reject task "${task.title}".`;
      }

      const updated = await Task.findByIdAndUpdate(req.params.id, updatePayload, { new: true })
        .populate("assignedTo", "firstName lastName email")
        .populate(LEAD_DEAL_POPULATE);

      // Notify the salesperson
      await createNotification(Notification, {
        userId: task.assignedTo._id,
        title: action === "approve" ? "Task Rejection Approved" : "Task Rejection Denied",
        message,
        type: "task",
        meta: { taskId: String(task._id), taskRejectionAction: action },
      });

      await broadcastTasksRefresh(User, Role, [task.assignedTo._id]);
      const updatedLean = attachLinkedArrays(attachLinkedItemBadge(updated.toObject()));
      res.status(200).json({ message: `Rejection ${action}d successfully`, data: updatedLean });
    } catch (err) {
      console.error("Error handling rejection request:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: approve or deny a hold request
  approveHold: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied: Admins only" });
      }
      const { Task, Notification, User, Role } = getModels(req);
      const { action, extendDueDate } = req.body; // "approve" or "deny"
      const task = await Task.findById(req.params.id);
      if (!task) return res.status(404).json({ message: "Task not found" });

      const adminName = `${req.user.firstName} ${req.user.lastName}`;
      let updatePayload = {};
      let message = "";

      if (action === "approve") {
        updatePayload = {
          status: "In Hold",
          holdRequested: false,
          holdApprovedAt: new Date(),
          $push: { history: { event: "HoldApproved", detail: `Hold approved by Admin ${adminName}${extendDueDate ? ` — due date extended to ${new Date(extendDueDate).toDateString()}` : ""}`, by: req.user._id, at: new Date() } },
        };
        if (extendDueDate) {
          updatePayload.dueDate = new Date(extendDueDate);
          updatePayload.reminderSentAt = null;
          updatePayload.dueTodaySentAt = null;
        }
        message = `Admin ${adminName} approved your request to place task "${task.title}" on hold.`;
      } else {
        updatePayload = {
          holdRequested: false,
          holdReason: "",
          $push: { history: { event: "HoldDenied", detail: `Hold denied by Admin ${adminName}`, by: req.user._id, at: new Date() } },
        };
        message = `Admin ${adminName} denied your request to place task "${task.title}" on hold.`;
      }

      const updated = await Task.findByIdAndUpdate(req.params.id, updatePayload, { new: true })
        .populate("assignedTo", "firstName lastName email")
        .populate(LEAD_DEAL_POPULATE);

      // Notify the salesperson
      await createNotification(Notification, {
        userId: task.assignedTo._id,
        title: action === "approve" ? "Task Hold Approved" : "Task Hold Denied",
        message,
        type: "task",
        meta: { taskId: String(task._id), taskHoldAction: action },
      });

      await broadcastTasksRefresh(User, Role, [task.assignedTo._id]);
      const updatedLean = attachLinkedArrays(attachLinkedItemBadge(updated.toObject()));
      res.status(200).json({ message: `Hold ${action}d successfully`, data: updatedLean });
    } catch (err) {
      console.error("Error handling hold request:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin only: reassign a task to a different (or the same) sales person —
  // used directly from the due-date reminder notifications.
  reassignTask: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied: Admins only" });
      }
      const { Task, Notification, User, Role, Lead, Deal } = getModels(req);
      const { newAssigneeId, note, extendDueDate } = req.body;
      if (!newAssigneeId) return res.status(400).json({ message: "newAssigneeId is required" });

      const task = await Task.findById(req.params.id).populate("assignedTo", "firstName lastName");
      if (!task) return res.status(404).json({ message: "Task not found" });

      const newUser = await User.findById(newAssigneeId).select("firstName lastName");
      if (!newUser) return res.status(404).json({ message: "User not found" });

      const adminName = `${req.user.firstName} ${req.user.lastName}`;
      const oldAssigneeId = String(task.assignedTo._id);
      const oldAssigneeName = `${task.assignedTo.firstName} ${task.assignedTo.lastName}`;
      const isSamePerson = oldAssigneeId === String(newAssigneeId);
      const resolvedDueDate = extendDueDate ? new Date(extendDueDate) : null;

      // Whichever leads/deals are currently linked to this task, captured
      // before the update — reassigning to a DIFFERENT person moves
      // ownership of these along with the task itself.
      const leadIdsToTransfer = (task.leadRefs && task.leadRefs.length) ? task.leadRefs.map(String) : (task.leadRef ? [String(task.leadRef)] : []);
      const dealIdsToTransfer = (task.dealRefs && task.dealRefs.length) ? task.dealRefs.map(String) : (task.dealRef ? [String(task.dealRef)] : []);
      const isTransferringLinkedItems = !isSamePerson && (leadIdsToTransfer.length > 0 || dealIdsToTransfer.length > 0);

      const historyEntries = [{
        event: "Reassigned",
        detail: isSamePerson
          ? `Kept with ${oldAssigneeName} by Admin ${adminName}${resolvedDueDate ? ` — due date extended` : ""}${note ? ` — Note: ${note}` : ""}`
          : `Reassigned from ${oldAssigneeName} to ${newUser.firstName} ${newUser.lastName} by Admin ${adminName}${note ? ` — Note: ${note}` : ""}`,
        by: req.user._id,
        at: new Date(),
      }];
      if (isTransferringLinkedItems) {
        historyEntries.push({
          event: "LinkedItemChanged",
          detail: `${leadIdsToTransfer.length} lead(s) and ${dealIdsToTransfer.length} deal(s) transferred to ${newUser.firstName} ${newUser.lastName} along with the task reassignment`,
          by: req.user._id,
          at: new Date(),
        });
      }

      const updatePayload = {
        assignedTo: newAssigneeId,
        $push: { history: { $each: historyEntries } },
        // Restart the reminder cycle — a fresh assignee/deadline shouldn't stay
        // silent just because the cron already fired for the old state.
        reminderSentAt: null,
        dueTodaySentAt: null,
      };
      if (resolvedDueDate) updatePayload.dueDate = resolvedDueDate;

      // Transfer ownership of the linked lead(s)/deal(s) to the new assignee —
      // same pattern as target.controller.js's reassignItem, minus its
      // `isActive` flag (that's Target's own overdue-tracking concern).
      if (isTransferringLinkedItems) {
        if (leadIdsToTransfer.length) await Lead.updateMany({ _id: { $in: leadIdsToTransfer } }, { assignTo: newAssigneeId });
        if (dealIdsToTransfer.length) await Deal.updateMany({ _id: { $in: dealIdsToTransfer } }, { assignedTo: newAssigneeId });
      }

      const updated = await Task.findByIdAndUpdate(req.params.id, updatePayload, { new: true })
        .populate(LEAD_DEAL_POPULATE);
      const updatedLean = attachLinkedArrays(attachLinkedItemBadge(updated.toObject()));

      // Mark the due-date reminder notifications for this task as resolved
      // everywhere they appear, so the "Reassign" button turns into a
      // completed indicator instead of staying clickable.
      await Notification.updateMany(
        { type: "task", "meta.taskId": String(task._id), $or: [{ "meta.taskReminder": true }, { "meta.taskDueToday": true }] },
        { $set: { "meta.resolved": true, "meta.resolvedToName": `${newUser.firstName} ${newUser.lastName}` } }
      );

      if (isSamePerson) {
        await createNotification(Notification, {
          userId: oldAssigneeId,
          title: "Task Deadline Extended",
          message: `Admin ${adminName} gave you more time on task "${task.title}".${resolvedDueDate ? ` New due date: ${resolvedDueDate.toDateString()}.` : ""}${note ? ` Note: ${note}` : ""}`,
          type: "task",
          meta: { taskId: String(task._id), taskReactivated: true, ...buildLinkedMeta(updated) },
        });
      } else {
        const transferNoteToNew = isTransferringLinkedItems ? " Its linked lead(s)/deal(s) now belong to you too." : "";
        const transferNoteToOld = isTransferringLinkedItems ? " Its linked lead(s)/deal(s) transferred with it." : "";
        await createNotification(Notification, {
          userId: newAssigneeId,
          title: "Task Reassigned to You",
          message: `Admin ${adminName} reassigned task "${task.title}" to you.${transferNoteToNew}${note ? ` Note: ${note}` : ""}`,
          type: "task",
          meta: { taskId: String(task._id), taskAssigned: true, ...buildLinkedMeta(updated) },
        });
        await createNotification(Notification, {
          userId: oldAssigneeId,
          title: "Task Reassigned",
          message: `Admin ${adminName} reassigned task "${task.title}" to ${newUser.firstName} ${newUser.lastName}.${transferNoteToOld}${note ? ` Note: ${note}` : ""}`,
          type: "task",
          meta: { taskId: String(task._id), taskRemoved: true, ...buildLinkedMeta(updated) },
        });
      }

      await broadcastTasksRefresh(User, Role, [oldAssigneeId, newAssigneeId]);

      res.status(200).json({ message: isSamePerson ? "Deadline extended" : "Task reassigned successfully", data: updatedLean });
    } catch (err) {
      console.error("Error reassigning task:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin only: delete task + all related notifications
  deleteTask: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied: Admins only" });
      }
      const { Task, Notification, User, Role } = getModels(req);
      const taskId = req.params.id;

      // Soft-delete: just hides the task from the list — the record (and its
      // history/reason notes) stays in the database, nothing is erased.
      const archived = await Task.findByIdAndUpdate(taskId, { archived: true });
      if (!archived) return res.status(404).json({ message: "Task not found" });

      // Find all notifications linked to this task
      // Query with both ObjectId and string since meta is a Mixed field —
      // Mongoose does NOT auto-cast nested mixed fields, so plain string lookup misses ObjectId-stored values
      let objectId = null;
      try { objectId = new mongoose.Types.ObjectId(taskId); } catch {}

      const query = objectId
        ? { $or: [{ "meta.taskId": taskId }, { "meta.taskId": objectId }] }
        : { "meta.taskId": taskId };

      const relatedNotifs = await Notification.find(query).select("_id userId");

      if (relatedNotifs.length > 0) {
        const notifIds = relatedNotifs.map((n) => n._id);
        const userIds  = [...new Set(relatedNotifs.map((n) => String(n.userId)))];

        // Delete all related notifications from DB
        await Notification.deleteMany({ _id: { $in: notifIds } });

        // Emit real-time event to every affected user so their UI removes them instantly
        const deletedIdStrings = notifIds.map(String);
        userIds.forEach((uid) => {
          notifyUser(uid, "notification_deleted", { ids: deletedIdStrings });
        });
      }

      await broadcastTasksRefresh(User, Role, [archived.assignedTo]);

      res.status(200).json({ message: "Task removed" });
    } catch (err) {
      console.error("Error deleting task:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Sales person (or admin) flags a task as stuck/delayed with a note sent to
  // admin for review — same reasonNotes pattern as Target's reason notes, but
  // scoped to a single task (no itemType/itemId needed).
  addReasonNote: async (req, res) => {
    try {
      const fs = (await import('fs')).default;
      const logFile = "d:/SAAS_CRM_BACKEND/debug.log";
      fs.appendFileSync(logFile, "\n--- addReasonNote started for Task ---\n");

      const { Task, Notification, User, Role } = getModels(req);
      const { note } = req.body;
      fs.appendFileSync(logFile, `Req body: ${JSON.stringify(req.body)}\n`);
      if (!note?.trim()) return res.status(400).json({ message: "Note is required" });

      const task = await Task.findById(req.params.id).populate("assignedTo", "firstName lastName");
      if (!task) return res.status(404).json({ message: "Task not found" });

      const isAdmin = req.user.role?.name === "Admin";
      const isAssigned = String(task.assignedTo._id) === String(req.user._id);
      if (!isAdmin && !isAssigned) return res.status(403).json({ message: "Access denied" });

      const actorName = `${req.user.firstName} ${req.user.lastName}`;

      task.reasonNotes.push({
        note: note.trim(),
        addedBy: req.user._id,
        addedAt: new Date(),
        status: "pending",
      });
      task.history.push({
        event: "IssueReported",
        detail: `${isAdmin ? "Admin " : ""}${actorName} reported an issue: ${note.trim()}`,
        by: req.user._id,
        at: new Date(),
      });
      fs.appendFileSync(logFile, "Saving task...\n");
      await task.save();
      fs.appendFileSync(logFile, "Task saved!\n");

      const admins = await findAdmins(User, Role);
      await Promise.all(admins.map((admin) => createNotification(Notification, {
        userId: admin._id,
        title: "Task Issue Reported",
        message: `${actorName} reported an issue with task "${task.title}": "${note.trim().substring(0, 100)}${note.length > 100 ? "..." : ""}"`,
        type: "task",
        meta: { taskId: String(task._id), reasonNote: true, noteIdx: task.reasonNotes.length - 1 },
      })));

      await broadcastTasksRefresh(User, Role, [task.assignedTo._id]);

      res.status(200).json({ message: "Issue reported to admin", reasonNotes: task.reasonNotes });
      fs.appendFileSync(logFile, "Success sent.\n");
    } catch (err) {
      const fs = (await import('fs')).default;
      fs.appendFileSync("d:/SAAS_CRM_BACKEND/debug.log", `ERROR in addReasonNote task: ${err.stack}\n`);
      console.error("Error adding task reason note:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: get all reason notes across all tasks, newest first
  getAllReasonNotes: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") return res.status(403).json({ message: "Access denied" });
      const { Task, Target } = getModels(req);
      const tasks = await Task.find({ "reasonNotes.0": { $exists: true }, archived: { $ne: true } })
        .populate("assignedTo", "firstName lastName email")
        .populate("reasonNotes.addedBy", "firstName lastName")
        .populate("reasonNotes.reassignedTo", "firstName lastName")
        .populate("leadRef", "leadName companyName phoneNumber email")
        .populate("dealRef", "dealName dealTitle companyName phoneNumber email")
        .populate("leadRefs", "status")
        .populate("dealRefs", "stage")
        .lean();

      const allAssigneeIds = [...new Set(tasks.map(t => String(t.assignedTo?._id)).filter(Boolean))];
      const activeTargets = await Target.find({
        salesPerson: { $in: allAssigneeIds },
        status: { $nin: ["Completed", "Closed", "Rejected"] }
      }).lean();

      const allNotes = [];
      for (const t of tasks) {
        const remainingLeads = (t.leadRefs || []).filter(l => l && l.status !== "Converted");
        const remainingDeals = (t.dealRefs || []).filter(d => d && d.stage !== "Closed Won" && d.stage !== "Closed Lost");

        const userTargets = activeTargets.filter(target => String(target.salesPerson) === String(t.assignedTo?._id));
        const overlappingTargetLeads = [];
        const overlappingTargetDeals = [];

        remainingLeads.forEach(lead => {
          const leadIdStr = String(lead._id);
          const foundTarget = userTargets.find(target => 
            target.linkedLeads && target.linkedLeads.some(ref => String(ref) === leadIdStr)
          );
          if (foundTarget) overlappingTargetLeads.push({ _id: lead._id, name: lead.leadName, targetId: foundTarget._id, targetName: foundTarget.title });
        });

        remainingDeals.forEach(deal => {
          const dealIdStr = String(deal._id);
          const foundTarget = userTargets.find(target => 
            target.linkedDeals && target.linkedDeals.some(ref => String(ref) === dealIdStr)
          );
          if (foundTarget) overlappingTargetDeals.push({ _id: deal._id, name: deal.dealName || deal.dealTitle, targetId: foundTarget._id, targetName: foundTarget.title });
        });

        for (let i = 0; i < t.reasonNotes.length; i++) {
          allNotes.push({
            ...t.reasonNotes[i],
            noteIdx: i,
            taskId: t._id,
            taskTitle: t.title,
            assignedTo: t.assignedTo,
            leadRef: t.leadRef,
            dealRef: t.dealRef,
            remainingLeadsCount: remainingLeads.length,
            remainingDealsCount: remainingDeals.length,
            remainingLeads,
            remainingDeals,
            overlappingTargetLeads,
            overlappingTargetDeals,
          });
        }
      }
      allNotes.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
      res.status(200).json(allNotes);
    } catch (err) {
      console.error("Error fetching task reason notes:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: resolve a reason note — either keep the task with the same sales
  // person (reactivated, optionally extending the due date) or reassign it to
  // someone else (resolved).
  reassignReasonNote: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") return res.status(403).json({ message: "Access denied" });
      const { Task, Notification, User, Role, Lead, Deal } = getModels(req);
      const { noteIdx } = req.params;
      const { reassignToUserId, adminNote, extendDueDate } = req.body;

      const task = await Task.findById(req.params.id)
        .populate("assignedTo", "firstName lastName")
        .populate("leadRefs", "status")
        .populate("dealRefs", "stage");
      if (!task) return res.status(404).json({ message: "Task not found" });

      const rn = task.reasonNotes[Number(noteIdx)];
      if (!rn) return res.status(404).json({ message: "Reason note not found" });

      const newUser = await User.findById(reassignToUserId).select("firstName lastName");
      if (!newUser) return res.status(404).json({ message: "User not found" });

      const isSamePerson = String(task.assignedTo._id) === String(reassignToUserId);
      const adminName = `${req.user.firstName} ${req.user.lastName}`;
      const oldAssigneeName = `${task.assignedTo.firstName} ${task.assignedTo.lastName}`;
      const originalAssigneeId = String(task.assignedTo._id);
      const resolvedDueDate = extendDueDate ? new Date(extendDueDate) : null;

      task.reasonNotes[Number(noteIdx)].status = isSamePerson ? "reactivated" : "resolved";
      task.reasonNotes[Number(noteIdx)].resolvedAt = new Date();
      task.reasonNotes[Number(noteIdx)].reassignedTo = reassignToUserId;
      task.reasonNotes[Number(noteIdx)].reassignNote = adminNote || "";

      if (isSamePerson) {
        if (resolvedDueDate) {
          task.dueDate = resolvedDueDate;
          task.reminderSentAt = null;
          task.dueTodaySentAt = null;
        }
        task.history.push({
          event: "IssueReviewed",
          detail: `Admin ${adminName} reviewed the reported issue and kept the task with ${oldAssigneeName}${adminNote ? ` — Note: ${adminNote}` : ""}`,
          by: req.user._id,
          at: new Date(),
        });
        await task.save();

        await createNotification(Notification, {
          userId: task.assignedTo._id,
          title: "Task Kept With You",
          message: `Admin ${adminName} reviewed your reported issue on "${task.title}" and kept it with you.${resolvedDueDate ? ` New due date: ${resolvedDueDate.toDateString()}.` : ""}${adminNote ? ` Note: ${adminNote}` : ""}`,
          type: "task",
          meta: { taskId: String(task._id), taskReactivated: true },
        });
      } else {
        const oldAssigneeId = String(task.assignedTo._id);
        
        // Calculate completed vs remaining items
        const completedLeads = [];
        const remainingLeads = [];
        for (const l of (task.leadRefs || [])) {
          if (l && l.status === "Converted") completedLeads.push(l._id);
          else if (l) remainingLeads.push(l._id);
        }

        const completedDeals = [];
        const remainingDeals = [];
        for (const d of (task.dealRefs || [])) {
          if (d && (d.stage === "Closed Won" || d.stage === "Closed Lost")) completedDeals.push(d._id);
          else if (d) remainingDeals.push(d._id);
        }

        if (completedLeads.length > 0 || completedDeals.length > 0) {
          // SPLIT THE TASK
          // Original task stays with old assignee, only keeping completed items
          task.leadRefs = completedLeads;
          task.dealRefs = completedDeals;
          task.leadRef = completedLeads.length > 0 ? completedLeads[completedLeads.length - 1] : null;
          task.dealRef = completedDeals.length > 0 ? completedDeals[completedDeals.length - 1] : null;
          task.status = "Completed";
          task.approvedByAdmin = true;
          task.history.push({
            event: "TaskSplit",
            detail: `Task split on reassignment by Admin ${adminName}. Completed items retained here, remaining items moved to new task assigned to ${newUser.firstName} ${newUser.lastName}.`,
            by: req.user._id,
            at: new Date(),
          });
          await task.save();

          if (remainingLeads.length > 0) {
            await Lead.updateMany({ _id: { $in: remainingLeads } }, { assignTo: reassignToUserId });
          }
          if (remainingDeals.length > 0) {
            await Deal.updateMany({ _id: { $in: remainingDeals } }, { assignedTo: reassignToUserId });
          }

          // Create new task for remaining items
          const newTask = new Task({
            title: task.title,
            description: task.description,
            priority: task.priority,
            dueDate: resolvedDueDate || task.dueDate,
            assignedTo: reassignToUserId,
            createdBy: task.createdBy,
            leadRefs: remainingLeads,
            dealRefs: remainingDeals,
            leadRef: remainingLeads.length > 0 ? remainingLeads[remainingLeads.length - 1] : null,
            dealRef: remainingDeals.length > 0 ? remainingDeals[remainingDeals.length - 1] : null,
            leadDueDates: task.leadDueDates,
            dealDueDates: task.dealDueDates,
            status: "Pending",
            history: [{
              event: "Created",
              detail: `Created from split task "${task.title}" reassigned by Admin ${adminName}.`,
              by: req.user._id,
              at: new Date()
            }]
          });
          await newTask.save();
        } else {
          // NO COMPLETED ITEMS: Normal Reassignment
          task.leadRefs = remainingLeads;
          task.dealRefs = remainingDeals;
          task.assignedTo = reassignToUserId;
          task.markModified("assignedTo"); // Mongoose might not detect changes to a populated field
          task.reminderSentAt = null;
          task.dueTodaySentAt = null;
          if (resolvedDueDate) {
            task.dueDate = resolvedDueDate;
          }
          task.history.push({
            event: "Reassigned",
            detail: `Reassigned from ${oldAssigneeName} to ${newUser.firstName} ${newUser.lastName} by Admin ${adminName}${resolvedDueDate ? ` — due date extended` : ""}${adminNote ? ` — Note: ${adminNote}` : ""}`,
            by: req.user._id,
            at: new Date(),
          });
          
          if (remainingLeads.length > 0) {
            await Lead.updateMany({ _id: { $in: remainingLeads } }, { assignTo: reassignToUserId });
          }
          if (remainingDeals.length > 0) {
            await Deal.updateMany({ _id: { $in: remainingDeals } }, { assignedTo: reassignToUserId });
          }

          await task.save();
        }

        // 2.5 Cascading Target Split
        const { Target } = getModels(req);
        const transferredLeadIdsStr = new Set(remainingLeads.map(String));
        const transferredDealIdsStr = new Set(remainingDeals.map(String));

        if (transferredLeadIdsStr.size > 0 || transferredDealIdsStr.size > 0) {
          const activeTargets = await Target.find({
            salesPerson: oldAssigneeId,
            status: { $nin: ["Completed", "Closed", "Rejected"] }
          });

          for (const tgt of activeTargets) {
            const tgtLeads = (tgt.linkedLeads || []).map(String);
            const tgtDeals = (tgt.linkedDeals || []).map(String);
            
            const hasOverlap = tgtLeads.some(l => transferredLeadIdsStr.has(l)) || tgtDeals.some(d => transferredDealIdsStr.has(d));
            
            if (hasOverlap) {
              const actuals = await computeActuals(
                getModels(req), 
                oldAssigneeId, 
                tgt.startDate, 
                tgt.endDate, 
                tgt.linkedLeads, 
                tgt.linkedDeals, 
                tgt.targetLeads, 
                tgt.targetDeals, 
                (tgt.reportedCalls || []).length, 
                (tgt.reportedMeetings || []).length, 
                tgt.linkedLeads && tgt.linkedLeads.length > 0, 
                tgt.linkedDeals && tgt.linkedDeals.length > 0
              );
              
              const tLeadsData = await Lead.find({ _id: { $in: tgt.linkedLeads } }).select("status");
              const completedLeadsForTarget = [];
              const remainingLeadsForTarget = [];
              for (const l of tLeadsData) {
                if (l.status === "Converted") completedLeadsForTarget.push(l._id);
                else remainingLeadsForTarget.push(l._id);
              }

              const tDealsData = await Deal.find({ _id: { $in: tgt.linkedDeals } }).select("stage");
              const completedDealsForTarget = [];
              const remainingDealsForTarget = [];
              for (const d of tDealsData) {
                if (d.stage === "Closed Won" || d.stage === "Closed Lost") completedDealsForTarget.push(d._id);
                else remainingDealsForTarget.push(d._id);
              }

              const totalActuals = actuals.leadsConverted + actuals.dealsWon + actuals.calls + actuals.meetings;
              let skipNewTargetCreation = false;
              let _splitRemainder = null;

              if (totalActuals > 0 || completedLeadsForTarget.length > 0 || completedDealsForTarget.length > 0) {
                _splitRemainder = {
                  targetLeads: Math.max(0, tgt.targetLeads - actuals.leadsConverted),
                  targetDeals: Math.max(0, tgt.targetDeals - actuals.dealsWon),
                  targetCalls: Math.max(0, tgt.targetCalls - actuals.calls),
                  targetMeetings: Math.max(0, tgt.targetMeetings - actuals.meetings),
                  linkedLeads: remainingLeadsForTarget,
                  linkedDeals: remainingDealsForTarget
                };
                
                tgt.targetLeads = actuals.leadsConverted;
                tgt.targetDeals = actuals.dealsWon;
                tgt.targetCalls = actuals.calls;
                tgt.targetMeetings = actuals.meetings;
                tgt.linkedLeads = completedLeadsForTarget;
                tgt.linkedDeals = completedDealsForTarget;
                tgt.status = "Completed";
                await tgt.save();
                skipNewTargetCreation = false;
              } else {
                tgt.salesPerson = reassignToUserId;
                skipNewTargetCreation = true;
                if (resolvedDueDate) {
                  tgt.endDate = resolvedDueDate;
                  tgt.reminderSentAt = null;
                  tgt.dueTodaySentAt = null;
                  tgt.expiredAt = null;
                }
                await tgt.save();
              }

              if (!skipNewTargetCreation) {
                const createPayload = {
                  title:          tgt.title || "Untitled Target",
                  salesPerson:    reassignToUserId,
                  period:         tgt.period,
                  startDate:      tgt.startDate,
                  endDate:        resolvedDueDate || tgt.endDate,
                  targetLeads:    _splitRemainder.targetLeads,
                  targetDeals:    _splitRemainder.targetDeals,
                  targetCalls:    _splitRemainder.targetCalls,
                  targetMeetings: _splitRemainder.targetMeetings,
                  description:    `Created from split target cascaded from Task reassignment.`,
                  createdBy:      req.user._id,
                  linkedLeads:    _splitRemainder.linkedLeads,
                  linkedDeals:    _splitRemainder.linkedDeals,
                };
                await Target.create(createPayload);
              }
            }
          }
        }

        await createNotification(Notification, {
          userId: reassignToUserId,
          title: "Task Reassigned to You",
          message: `Admin ${adminName} reassigned task "${task.title}" to you.${adminNote ? ` Note: ${adminNote}` : ""}`,
          type: "task",
          meta: { taskId: String(task._id), taskAssigned: true },
        });
        await createNotification(Notification, {
          userId: oldAssigneeId,
          title: "Task Reassigned",
          message: `Admin ${adminName} reassigned task "${task.title}" to ${newUser.firstName} ${newUser.lastName}.${adminNote ? ` Note: ${adminNote}` : ""}`,
          type: "task",
          meta: { taskId: String(task._id), taskRemoved: true },
        });
      }

      const updated = await Task.findById(task._id).populate(LEAD_DEAL_POPULATE);
      await broadcastTasksRefresh(User, Role, [originalAssigneeId, reassignToUserId]);
      res.status(200).json({
        message: isSamePerson ? "Kept with same sales person" : "Task reassigned",
        data: attachLinkedArrays(attachLinkedItemBadge(updated.toObject())),
      });
    } catch (err) {
      console.error("Error resolving task reason note:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: mark a reason note as read (resolved) without reassigning
  markReasonNoteRead: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") return res.status(403).json({ message: "Access denied" });
      const { Task, Notification, User, Role } = getModels(req);
      const { noteIdx } = req.params;

      const task = await Task.findById(req.params.id);
      if (!task) return res.status(404).json({ message: "Task not found" });

      const rn = task.reasonNotes[Number(noteIdx)];
      if (!rn) return res.status(404).json({ message: "Reason note not found" });

      task.reasonNotes[Number(noteIdx)].status = "resolved";
      task.reasonNotes[Number(noteIdx)].resolvedAt = new Date();
      await task.save();

      const updated = await Task.findById(task._id).populate(LEAD_DEAL_POPULATE);
      await broadcastTasksRefresh(User, Role, [task.assignedTo]);
      res.status(200).json({
        message: "Marked as read",
        data: attachLinkedArrays(attachLinkedItemBadge(updated.toObject())),
      });
    } catch (err) {
      console.error("Error marking task reason note as read:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  rejectReasonNote: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") return res.status(403).json({ message: "Access denied" });
      const { Task, Notification } = getModels(req);
      const { noteIdx } = req.params;
      const { rejectReason } = req.body;

      const task = await Task.findById(req.params.id).populate("assignedTo", "firstName lastName _id");
      if (!task) return res.status(404).json({ message: "Task not found" });

      const nIdx = parseInt(noteIdx, 10);
      if (isNaN(nIdx) || nIdx < 0 || nIdx >= task.reasonNotes.length) {
        return res.status(400).json({ message: "Invalid note index" });
      }

      const rn = task.reasonNotes[nIdx];
      if (rn.status !== "pending") {
        return res.status(400).json({ message: "Reason note is not pending" });
      }

      rn.status = "rejected";
      rn.rejectReason = rejectReason || "";
      rn.resolvedAt = new Date();
      await task.save();

      const adminName = `${req.user.firstName} ${req.user.lastName}`;
      if (task.assignedTo) {
        await createNotification(Notification, {
          userId: task.assignedTo._id,
          title: "Task Delay Reason Rejected",
          message: `Admin ${adminName} rejected your delay reason for task "${task.title}".${rejectReason ? ` Admin note: ${rejectReason}` : ""}\nPlease submit a new valid reason.`,
          type: "task",
          meta: { taskId: String(task._id), taskReasonRejected: true },
        });
        notifyUser(String(task.assignedTo._id), "tasks_refresh", {});
      }

      res.status(200).json({ message: "Reason note rejected" });
    } catch (error) {
      console.error("[rejectReasonNote] error:", error);
      res.status(500).json({ message: "Server Error", error: error.message });
    }
  },

  // Admin: delete a single reason note
  deleteReasonNote: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") return res.status(403).json({ message: "Access denied" });
      const { Task } = getModels(req);
      const task = await Task.findById(req.params.id);
      if (!task) return res.status(404).json({ message: "Task not found" });
      if (!task.reasonNotes[Number(req.params.noteIdx)]) return res.status(404).json({ message: "Reason note not found" });
      task.reasonNotes.splice(Number(req.params.noteIdx), 1);
      await task.save();
      res.status(200).json({ message: "Reason note deleted" });
    } catch (err) {
      console.error("Error deleting task reason note:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: bulk-delete reason notes across multiple tasks — items: [{ taskId, noteIdx }]
  bulkDeleteReasonNotes: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") return res.status(403).json({ message: "Access denied" });
      const { Task } = getModels(req);
      const { items } = req.body;
      if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ message: "items is required" });

      const byTask = new Map();
      for (const { taskId, noteIdx } of items) {
        if (!byTask.has(taskId)) byTask.set(taskId, []);
        byTask.get(taskId).push(Number(noteIdx));
      }

      for (const [taskId, idxs] of byTask.entries()) {
        const task = await Task.findById(taskId);
        if (!task) continue;
        idxs.sort((a, b) => b - a).forEach((idx) => task.reasonNotes.splice(idx, 1));
        await task.save();
      }

      res.status(200).json({ message: `${items.length} note(s) deleted` });
    } catch (err) {
      console.error("Error bulk deleting task reason notes:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin-only: leads Admin personally converted + deals Admin personally
  // closed Won — the "Admin Completed" activity feed in Task Management.
  // Strictly Task-scoped: an item that's linked ONLY to a Target (not any
  // Task) belongs in Target Management's own Admin Completed feed instead
  // (see target.controller.js's getAdminActivity) — showing it here too would
  // be exactly the Task/Target cross-bleed this boundary exists to prevent.
  // Items linked to neither a Task nor a Target still fall back to showing
  // here, same as before this filter existed.
  getAdminActivity: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") return res.status(403).json({ message: "Access denied: Admins only" });
      const models = getModels(req);
      const { Lead, Deal } = models;

      const [convertedLeads, wonDeals, linkage] = await Promise.all([
        Lead.find({ status: "Converted", convertedBy: { $ne: null }, taskAdminActivityDismissed: { $ne: true } })
          .populate({ path: "convertedBy", select: "firstName lastName role", populate: { path: "role", select: "name" } })
          .populate("assignTo", "firstName lastName")
          .select("leadName companyName convertedBy assignTo updatedAt")
          .sort({ updatedAt: -1 })
          .lean(),
        Deal.find({ stage: "Closed Won", wonBy: { $ne: null }, taskAdminActivityDismissed: { $ne: true } })
          .populate({ path: "wonBy", select: "firstName lastName role", populate: { path: "role", select: "name" } })
          .populate("assignedTo", "firstName lastName")
          .select("dealName dealTitle companyName value currency wonBy wonAt assignedTo")
          .sort({ wonAt: -1 })
          .lean(),
        getBulkLinkage(models),
      ]);

      const { taskLeadIds, taskDealIds, targetLeadIds, targetDealIds } = linkage;
      const isTaskScoped = (id, taskIds, targetIds) => taskIds.has(String(id)) || !targetIds.has(String(id));

      const leadsConvertedByAdmin = convertedLeads
        .filter((l) => l.convertedBy?.role?.name === "Admin")
        .filter((l) => isTaskScoped(l._id, taskLeadIds, targetLeadIds));
      const dealsWonByAdmin = wonDeals
        .filter((d) => d.wonBy?.role?.name === "Admin")
        .filter((d) => isTaskScoped(d._id, taskDealIds, targetDealIds));

      res.status(200).json({
        leadsConvertedByAdmin,
        dealsWonByAdmin,
        counts: { leads: leadsConvertedByAdmin.length, deals: dealsWonByAdmin.length },
      });
    } catch (err) {
      console.error("Error fetching admin activity:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin-only: dismiss (hide) a single lead/deal row from Task Management's
  // "Admin Completed" feed — declutter only, never touches the underlying
  // record, and never affects Target Management's own Admin Completed feed
  // (separate targetAdminActivityDismissed flag).
  dismissAdminActivity: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") return res.status(403).json({ message: "Access denied: Admins only" });
      const { itemType, itemId } = req.body;
      if (!["lead", "deal"].includes(itemType) || !itemId) {
        return res.status(400).json({ message: "itemType (lead|deal) and itemId are required" });
      }
      const { Lead, Deal } = getModels(req);
      const Model = itemType === "lead" ? Lead : Deal;
      await Model.findByIdAndUpdate(itemId, { taskAdminActivityDismissed: true });
      res.status(200).json({ message: "Removed from Admin Completed" });
    } catch (err) {
      console.error("Error dismissing admin activity item:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Sales: their own Progress-card ratio for every one of their tasks, in
  // one batched call — see services/taskProgressService.js. Kept entirely
  // separate from Target Management's own progress endpoints (different
  // file, no shared function) so a change here can never affect Target
  // Management/My Targets.
  getMyTaskProgress: async (req, res) => {
    try {
      const { Task } = getModels(req);
      const myTasks = await Task.find({ assignedTo: req.user._id, archived: { $ne: true } })
        .select("leadRef dealRef leadRefs dealRefs")
        .lean();
      const snapshot = await computeTaskProgress(getModels(req), req.user._id, myTasks);
      res.status(200).json(snapshot);
    } catch (err) {
      console.error("Error fetching my task progress:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: same Progress-card ratios, batched for every Sales-role user in
  // one call — powers Task Management's card for every assignee without an
  // N+1 fetch per task card. Flattened into one object keyed by taskId.
  getTaskProgressAll: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied: Admins only" });
      }
      const models = getModels(req);
      const { User, Role, Task } = models;
      const adminRole = await Role.findOne({ name: "Admin" });
      const salesUsers = await User.find({ role: { $ne: adminRole?._id } }).select("_id").lean();

      const allTasks = await Task.find({ archived: { $ne: true } }).select("assignedTo leadRef dealRef leadRefs dealRefs").lean();
      const tasksByUser = new Map();
      for (const t of allTasks) {
        const uid = String(t.assignedTo);
        if (!tasksByUser.has(uid)) tasksByUser.set(uid, []);
        tasksByUser.get(uid).push(t);
      }

      const perUserMaps = await Promise.all(
        salesUsers.map((u) => computeTaskProgress(models, u._id, tasksByUser.get(String(u._id)) || []))
      );
      res.status(200).json(Object.assign({}, ...perUserMaps));
    } catch (err) {
      console.error("Error fetching task progress for all sales users:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  checkReassignment: async (req, res) => {
    try {
      const { Task, Target } = getModels(req);
      const { itemType, itemId, oldUserId } = req.params;

      if (!itemType || !itemId || !oldUserId) {
        return res.status(400).json({ message: "Missing required parameters" });
      }

      const activeTasks = await Task.find({
        assignedTo: oldUserId,
        status: { $ne: "Completed" },
        archived: { $ne: true },
        $or: [
          itemType === "deal" ? { dealRefs: itemId } : { leadRefs: itemId },
          itemType === "deal" ? { dealRef: itemId } : { leadRef: itemId }
        ]
      });

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const activeTargets = await Target.find({
        salesPerson: oldUserId,
        endDate: { $gte: today },
        ...(itemType === "deal" ? { linkedDeals: itemId } : { linkedLeads: itemId })
      });

      res.status(200).json({
        hasActiveTasks: activeTasks.length > 0,
        hasActiveTargets: activeTargets.length > 0,
        tasksCount: activeTasks.length,
        targetsCount: activeTargets.length
      });
    } catch (error) {
      console.error("Error in checkReassignment:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  },
};