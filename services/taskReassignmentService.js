import mongoose from "mongoose";
import {
  createNotification,
  broadcastTasksRefresh,
  buildLinkedMeta,
} from "./taskNotificationService.js";

export const handleReassignmentOptions = async (
  req,
  models,
  itemType,
  itemId,
  oldUserId,
  newUserId,
  options,
  actorId
) => {
  const { Task, Target, Notification, User, Role } = models;

  if (!options) return;

  const {
    taskAction,
    newTaskName,
    extendedTaskDueDate,
    extendedTaskDescription,
    targetAction,
    extendedTargetEndDate,
    extendedTargetDescription,
  } = options;

  const objectId = typeof itemId === "string" ? new mongoose.Types.ObjectId(itemId) : itemId;

  // 1. Handle Targets: Unlink the deal/lead from old user's active targets
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const activeTargets = await Target.find({
    salesPerson: oldUserId,
    endDate: { $gte: today },
    ...(itemType === "deal" ? { linkedDeals: objectId } : { linkedLeads: objectId }),
  });

  for (const target of activeTargets) {
    if (itemType === "deal") {
      target.linkedDeals = target.linkedDeals.filter((id) => String(id) !== String(objectId));
    } else {
      target.linkedLeads = target.linkedLeads.filter((id) => String(id) !== String(objectId));
    }
    await target.save();
  }

  // 1b. Handle Targets: Create a new target for the new user if continuing
  if (targetAction === "continue" && activeTargets.length > 0) {
    // We ALWAYS create a new target for the new salesperson to keep it in the "New" pipeline view,
    // as per recent admin requirements for target reassignment.
    
    // Default to the end of the current month if no extended date is provided
    let newEndDate = extendedTargetEndDate ? new Date(extendedTargetEndDate) : null;
    if (!newEndDate) {
      newEndDate = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      newEndDate.setHours(23, 59, 59, 999);
    }

    let finalDescription = `Assigned by admin - ${itemType} reassignment`;
    if (extendedTargetDescription && extendedTargetDescription.trim() !== "") {
      finalDescription += `\nAdmin Note:\n${extendedTargetDescription}`;
    }

    await Target.create({
      salesPerson: newUserId,
      period: "monthly",
      startDate: today,
      endDate: newEndDate,
      targetLeads: 0,
      targetDeals: 0,
      targetCalls: 0,
      targetMeetings: 0,
      description: finalDescription,
      createdBy: actorId,
      linkedLeads: itemType === "lead" ? [objectId] : [],
      linkedDeals: itemType === "deal" ? [objectId] : [],
    });
  }

  // 2. Handle Tasks
  const activeTasks = await Task.find({
    assignedTo: oldUserId,
    status: { $ne: "Completed" },
    archived: { $ne: true },
    $or: [
      itemType === "deal" ? { dealRefs: objectId } : { leadRefs: objectId },
      itemType === "deal" ? { dealRef: objectId } : { leadRef: objectId },
    ],
  });

  for (const task of activeTasks) {
    // If taskAction is "continue", we clone the task for the new user,
    // containing ONLY this deal/lead, with the extended due date.
    if (taskAction === "continue") {
      const clonedDueDate = extendedTaskDueDate ? new Date(extendedTaskDueDate) : task.dueDate;
      
      const newLeadRefs = itemType === "lead" ? [objectId] : [];
      const newDealRefs = itemType === "deal" ? [objectId] : [];
      
      let finalDescription = task.description || "";
      if (extendedTaskDescription && extendedTaskDescription.trim() !== "") {
        finalDescription += finalDescription 
          ? `\n\nAdmin Note for Reassignment:\n${extendedTaskDescription}` 
          : `Admin Note for Reassignment:\n${extendedTaskDescription}`;
      }

      const clonedTask = await Task.create({
        title: newTaskName ? newTaskName.trim() : task.title,
        description: finalDescription,
        priority: task.priority,
        dueDate: clonedDueDate,
        assignedTo: newUserId,
        createdBy: actorId,
        leadRef: newLeadRefs.length ? newLeadRefs[0] : null,
        dealRef: newDealRefs.length ? newDealRefs[0] : null,
        leadRefs: newLeadRefs,
        dealRefs: newDealRefs,
        status: "Pending",
        history: [
          {
            event: "Created",
            detail: `Task cloned due to item reassignment (Original Task: ${task.title})`,
            by: actorId,
            at: new Date(),
          },
        ],
      });

      // Populate to build meta
      const populated = await clonedTask.populate([
        { path: "assignedTo", select: "firstName lastName email" },
        { path: "createdBy", select: "firstName lastName email" },
        { path: "leadRef", select: "leadName companyName phoneNumber email" },
        { path: "dealRef", select: "dealName dealTitle companyName phoneNumber email" },
      ]);

      // Notify new assignee
      if (Notification) {
        await createNotification(Notification, {
          userId: newUserId,
          title: "New Task Assigned (Reassigned Item)",
          message: `A task was cloned and assigned to you because its linked ${itemType} was reassigned to you.`,
          type: "task",
          meta: { taskId: String(clonedTask._id), taskAssigned: true, ...buildLinkedMeta(populated) },
        });
      }
    }

    // Regardless of "continue" or "reassign", we MUST unlink the item from the old task.
    if (itemType === "deal") {
      task.dealRefs = task.dealRefs.filter((id) => String(id) !== String(objectId));
      if (String(task.dealRef) === String(objectId)) {
        task.dealRef = task.dealRefs.length ? task.dealRefs[task.dealRefs.length - 1] : null;
      }
      if (task.dealDueDates && task.dealDueDates.has(String(objectId))) {
        task.dealDueDates.delete(String(objectId));
      }
    } else {
      task.leadRefs = task.leadRefs.filter((id) => String(id) !== String(objectId));
      if (String(task.leadRef) === String(objectId)) {
        task.leadRef = task.leadRefs.length ? task.leadRefs[task.leadRefs.length - 1] : null;
      }
      if (task.leadDueDates && task.leadDueDates.has(String(objectId))) {
        task.leadDueDates.delete(String(objectId));
      }
    }

    // If the old task has no more deals AND no more leads, archive it.
    const hasLeads = task.leadRefs && task.leadRefs.length > 0;
    const hasDeals = task.dealRefs && task.dealRefs.length > 0;
    if (!hasLeads && !hasDeals && !task.leadRef && !task.dealRef) {
      task.archived = true;
      task.history.push({
        event: "LinkedItemChanged",
        detail: `Item unlinked due to reassignment to another user. Task archived because no linked items remain.`,
        by: actorId,
        at: new Date(),
      });
    } else {
      task.history.push({
        event: "LinkedItemChanged",
        detail: `Item unlinked due to reassignment to another user`,
        by: actorId,
        at: new Date(),
      });
    }

    await task.save();
  }

  // Refresh tasks UI for both old and new user
  if (User && Role && (activeTasks.length > 0)) {
    await broadcastTasksRefresh(User, Role, [oldUserId, newUserId]);
  }
};
