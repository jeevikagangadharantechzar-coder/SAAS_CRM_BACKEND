import mongoose from "mongoose";
import { getTenantModels } from "../models/tenant/index.js";
import { notifyUser } from "../realtime/socket.js";
import {
  createNotification,
  findAdmins,
  broadcastTasksRefresh,
  LEAD_DEAL_POPULATE,
  attachLinkedItemBadge,
  buildLinkedMeta,
  attachConvertedDealJourney,
} from "../services/taskNotificationService.js";
import { getBulkLinkage } from "../services/linkageService.js";

const getModels = (req) => getTenantModels(req.tenantDB);

export default {
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

      res.status(200).json(rawTasks.map(attachLinkedItemBadge));
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
      const { title, description, priority, dueDate, assignedTo, leadRef, dealRef, callsMade, meetingsDone } = req.body;
      const adminName = `${req.user.firstName} ${req.user.lastName}`;

      const task = await Task.create({
        title,
        description,
        priority,
        dueDate,
        assignedTo,
        leadRef: leadRef || null,
        dealRef: dealRef || null,
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

      // Narrow exception to the sales-permitted field list: the assignee can
      // dismiss (unlink) a Closed-Won deal's history card from their task —
      // their own trophy to keep or clear once they've seen it, regardless
      // of whether they closed it themselves or Admin closed it on their
      // behalf (both stay visible on their list; this is just their own
      // manual "I've seen it" cleanup, not a hide-from-them action).
      let dismissingOwnWonDeal = false;
      if (!isAdmin && req.body.dismissWonDeal && task.dealRef) {
        const linkedDeal = await Deal.findById(task.dealRef).select("stage wonBy");
        if (linkedDeal?.stage === "Closed Won") {
          dismissingOwnWonDeal = true;
        }
      }

      // Build update payload
      const updatePayload = isAdmin
        ? { ...req.body }
        : dismissingOwnWonDeal
          ? { dealRef: null }
          : { status: req.body.status, completionNotes: req.body.completionNotes };

      // "" (cleared in the UI) can't cast to ObjectId — normalize to null
      if (isAdmin) {
        if (updatePayload.leadRef === "") updatePayload.leadRef = null;
        if (updatePayload.dealRef === "") updatePayload.dealRef = null;
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

      // Did the admin attach/change the linked lead or deal on this edit?
      const beforeLead = task.leadRef ? String(task.leadRef) : null;
      const beforeDeal = task.dealRef ? String(task.dealRef) : null;
      const afterLead = "leadRef" in updatePayload ? (updatePayload.leadRef ? String(updatePayload.leadRef) : null) : beforeLead;
      const afterDeal = "dealRef" in updatePayload ? (updatePayload.dealRef ? String(updatePayload.dealRef) : null) : beforeDeal;
      const linkedItemChanged = isAdmin && (afterLead !== beforeLead || afterDeal !== beforeDeal);

      // Defensive safeguard: a task should never end up actively pointing at
      // a deal that's already Closed Won (the deal-linking picker already
      // hides such deals, but this covers any other path that could still
      // link one) — archive it immediately instead of leaving a stale,
      // already-resolved deal sitting in an "active" task.
      let linkingToAlreadyWonDeal = false;
      if (afterDeal && afterDeal !== beforeDeal) {
        const linkedDeal = await Deal.findById(afterDeal).select("stage");
        if (linkedDeal?.stage === "Closed Won") linkingToAlreadyWonDeal = true;
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

      const updated = await Task.findByIdAndUpdate(req.params.id, updatePayload, {
        new: true,
        runValidators: true,
      }).populate(LEAD_DEAL_POPULATE);
      const updatedObj = updated.toObject();
      await attachConvertedDealJourney(Deal, [updatedObj]);
      const updatedLean = attachLinkedItemBadge(updatedObj);

      // Admin attached/changed the linked lead or deal → notify the assigned
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

      if (notesAdded) {
        const admins = await findAdmins(User, Role);
        const salesName = `${req.user.firstName} ${req.user.lastName}`;
        for (const admin of admins) {
          await createNotification(Notification, {
            userId: admin._id,
            title: "Task Note Added",
            message: `${salesName} added a note on task "${task.title}": ${req.body.completionNotes}`,
            type: "task",
            meta: { taskId: String(task._id), taskNoteAdded: true, completionNotes: req.body.completionNotes, ...buildLinkedMeta(updated) },
          });
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

  // Admin only: reassign a task to a different (or the same) sales person —
  // used directly from the due-date reminder notifications.
  reassignTask: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") {
        return res.status(403).json({ message: "Access denied: Admins only" });
      }
      const { Task, Notification, User, Role } = getModels(req);
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

      const updatePayload = {
        assignedTo: newAssigneeId,
        $push: {
          history: {
            event: "Reassigned",
            detail: isSamePerson
              ? `Kept with ${oldAssigneeName} by Admin ${adminName}${resolvedDueDate ? ` — due date extended` : ""}${note ? ` — Note: ${note}` : ""}`
              : `Reassigned from ${oldAssigneeName} to ${newUser.firstName} ${newUser.lastName} by Admin ${adminName}${note ? ` — Note: ${note}` : ""}`,
            by: req.user._id,
            at: new Date(),
          },
        },
        // Restart the reminder cycle — a fresh assignee/deadline shouldn't stay
        // silent just because the cron already fired for the old state.
        reminderSentAt: null,
        dueTodaySentAt: null,
      };
      if (resolvedDueDate) updatePayload.dueDate = resolvedDueDate;

      const updated = await Task.findByIdAndUpdate(req.params.id, updatePayload, { new: true })
        .populate(LEAD_DEAL_POPULATE);
      const updatedLean = attachLinkedItemBadge(updated.toObject());

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
        await createNotification(Notification, {
          userId: newAssigneeId,
          title: "Task Reassigned to You",
          message: `Admin ${adminName} reassigned task "${task.title}" to you.${note ? ` Note: ${note}` : ""}`,
          type: "task",
          meta: { taskId: String(task._id), taskAssigned: true, ...buildLinkedMeta(updated) },
        });
        await createNotification(Notification, {
          userId: oldAssigneeId,
          title: "Task Reassigned",
          message: `Admin ${adminName} reassigned task "${task.title}" to ${newUser.firstName} ${newUser.lastName}.${note ? ` Note: ${note}` : ""}`,
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
      const { Task, Notification, User, Role } = getModels(req);
      const { note } = req.body;
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
      await task.save();

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
    } catch (err) {
      console.error("Error adding task reason note:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Admin: get all reason notes across all tasks, newest first
  getAllReasonNotes: async (req, res) => {
    try {
      if (req.user.role?.name !== "Admin") return res.status(403).json({ message: "Access denied" });
      const { Task } = getModels(req);
      const tasks = await Task.find({ "reasonNotes.0": { $exists: true }, archived: { $ne: true } })
        .populate("assignedTo", "firstName lastName email")
        .populate("reasonNotes.addedBy", "firstName lastName")
        .populate("reasonNotes.reassignedTo", "firstName lastName")
        .populate("leadRef", "leadName companyName phoneNumber email")
        .populate("dealRef", "dealName dealTitle companyName phoneNumber email")
        .lean();

      const allNotes = [];
      for (const t of tasks) {
        for (let i = 0; i < t.reasonNotes.length; i++) {
          allNotes.push({
            ...t.reasonNotes[i],
            noteIdx: i,
            taskId: t._id,
            taskTitle: t.title,
            assignedTo: t.assignedTo,
            leadRef: t.leadRef,
            dealRef: t.dealRef,
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
      const { Task, Notification, User, Role } = getModels(req);
      const { noteIdx } = req.params;
      const { reassignToUserId, adminNote, extendDueDate } = req.body;

      const task = await Task.findById(req.params.id).populate("assignedTo", "firstName lastName");
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
        task.assignedTo = reassignToUserId;
        task.reminderSentAt = null;
        task.dueTodaySentAt = null;
        task.history.push({
          event: "Reassigned",
          detail: `Reassigned from ${oldAssigneeName} to ${newUser.firstName} ${newUser.lastName} by Admin ${adminName} (from reported issue)${adminNote ? ` — Note: ${adminNote}` : ""}`,
          by: req.user._id,
          at: new Date(),
        });
        await task.save();

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
        data: attachLinkedItemBadge(updated.toObject()),
      });
    } catch (err) {
      console.error("Error resolving task reason note:", err);
      res.status(500).json({ message: "Internal server error" });
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
};
