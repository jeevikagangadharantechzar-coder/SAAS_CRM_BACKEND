import mongoose from "mongoose";
import { getTenantModels } from "../models/tenant/index.js";
import { notifyUser } from "../realtime/socket.js";

const getModels = (req) => getTenantModels(req.tenantDB);

// Helper: persist notification in DB and emit via socket
async function createNotification(Notification, { userId, title, message, type, meta }) {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
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

// Helper: find all admin users in this tenant
async function findAdmins(User, Role) {
  const adminRole = await Role.findOne({ name: "Admin" });
  if (!adminRole) return [];
  return User.find({ role: adminRole._id, status: "Active" }).select("_id");
}

export default {
  // Admin: get all tasks; Sales: get assigned (non-approved) tasks
  getTasks: async (req, res) => {
    try {
      const { Task } = getModels(req);
      const isAdmin = req.user.role?.name === "Admin";

      let query;
      if (isAdmin) {
        query = {};
      } else {
        // Sales only sees tasks not yet approved by admin
        query = { assignedTo: req.user._id, approvedByAdmin: { $ne: true } };
      }

      const tasks = await Task.find(query)
        .populate("assignedTo", "firstName lastName email profileImage")
        .populate("createdBy", "firstName lastName email")
        .populate("leadRef", "leadName companyName status")
        .populate("dealRef", "dealName dealTitle stage")
        .sort({ createdAt: -1 });

      res.status(200).json(tasks);
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
      const { title, description, priority, dueDate, assignedTo, leadRef, dealRef } = req.body;

      const task = await Task.create({
        title,
        description,
        priority,
        dueDate,
        assignedTo,
        leadRef: leadRef || null,
        dealRef: dealRef || null,
        createdBy: req.user._id,
        status: "Pending",
      });

      const populated = await task.populate([
        { path: "assignedTo", select: "firstName lastName email" },
        { path: "createdBy", select: "firstName lastName email" },
      ]);

      // Notify assigned sales person
      const adminName = `${req.user.firstName} ${req.user.lastName}`;
      await createNotification(Notification, {
        userId: assignedTo,
        title: "New Task Assigned",
        message: `Admin ${adminName} assigned you a new task: "${title}"`,
        type: "task",
        meta: { taskId: String(task._id), taskAssigned: true },
      });

      res.status(201).json({ message: "Task created successfully", data: populated });
    } catch (err) {
      console.error("Error creating task:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Update task: sales can update status + completionNotes; admin can update all fields
  updateTask: async (req, res) => {
    try {
      const { Task, Notification, User, Role } = getModels(req);
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

      // Build update payload
      const updatePayload = isAdmin
        ? req.body
        : { status: req.body.status, completionNotes: req.body.completionNotes };

      if (nowCompleting) {
        updatePayload.completedAt = new Date();
        updatePayload.approvedByAdmin = false; // reset approval on re-completion
      }

      const updated = await Task.findByIdAndUpdate(req.params.id, updatePayload, {
        new: true,
        runValidators: true,
      })
        .populate("assignedTo", "firstName lastName email")
        .populate("createdBy", "firstName lastName email");

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
            meta: { taskId: String(task._id), taskCompleted: true, completionNotes: notes },
          });
        }
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
            meta: { taskId: String(task._id), taskNoteAdded: true, completionNotes: req.body.completionNotes },
          });
        }
      }

      res.status(200).json({ message: "Task updated", data: updated });
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
      const { Task, Notification } = getModels(req);
      const task = await Task.findById(req.params.id)
        .populate("leadRef", "leadName companyName")
        .populate("dealRef", "dealName dealTitle");
      if (!task) return res.status(404).json({ message: "Task not found" });

      const updated = await Task.findByIdAndUpdate(
        req.params.id,
        { approvedByAdmin: true },
        { new: true }
      ).populate("assignedTo", "firstName lastName email");

      // Build rich notification message
      const adminName = `${req.user.firstName} ${req.user.lastName}`;
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
        },
      });

      res.status(200).json({ message: "Task approved", data: updated });
    } catch (err) {
      console.error("Error approving task:", err);
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

      const deleted = await Task.findByIdAndDelete(taskId);
      if (!deleted) return res.status(404).json({ message: "Task not found" });

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

      res.status(200).json({ message: "Task deleted successfully" });
    } catch (err) {
      console.error("Error deleting task:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },
};
