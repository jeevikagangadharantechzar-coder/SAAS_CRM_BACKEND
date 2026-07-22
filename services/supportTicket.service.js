import mongoose from "mongoose";
import SupportTicket from "../models/master/SupportTicket.js";

const appError = (message, statusCode) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

const appendMessage = async (ticket, { sender, senderName, text }) => {
  if (!text?.trim()) throw appError("Message is required", 400);

  ticket.timeline.push({ type: "message", sender, senderName, text: text.trim() });

  // Platform replying to a still-untouched ticket implicitly starts progress.
  if (sender === "platform" && ticket.status === "Pending") {
    ticket.status = "In Progress";
    ticket.timeline.push({ type: "status_change", sender: "platform", senderName, status: "In Progress" });
  }

  await ticket.save();
  return ticket;
};

export const createTicket = async ({ tenantId, submittedByName, submittedByEmail, subject, message, priority, attachmentPath, attachmentName }) => {
  if (!subject?.trim()) throw appError("Subject is required", 400);
  if (!message?.trim()) throw appError("Details are required", 400);

  const ticket = await SupportTicket.create({
    tenant_id: tenantId,
    submittedByName,
    submittedByEmail,
    subject: subject.trim(),
    priority: priority || "Medium",
    attachmentPath: attachmentPath || "",
    attachmentName: attachmentName || "",
    timeline: [{ type: "message", sender: "tenant", senderName: submittedByName, text: message.trim() }],
  });

  return ticket;
};

export const getTicketsForTenant = async (tenantId) => {
  return SupportTicket.find({ tenant_id: tenantId }).sort({ createdAt: -1 });
};

export const listTickets = async ({ search, status, priority, dateFrom, dateTo, page = 1, limit = 10 }) => {
  const filter = {};

  if (status && status !== "All") filter.status = status;
  if (priority && priority !== "All") filter.priority = priority;

  if (search) {
    const regex = new RegExp(search.trim(), "i");
    filter.$or = [{ subject: regex }, { submittedByName: regex }, { submittedByEmail: regex }];
  }

  if (dateFrom || dateTo) {
    filter.createdAt = {};
    if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
    if (dateTo) filter.createdAt.$lte = new Date(`${dateTo}T23:59:59.999Z`);
  }

  const skip = (Number(page) - 1) * Number(limit);

  const [tickets, total] = await Promise.all([
    SupportTicket.find(filter)
      .populate("tenant_id", "name slug")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit)),
    SupportTicket.countDocuments(filter),
  ]);

  return { tickets, total };
};

export const getTicketById = async (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw appError("Invalid ticket ID", 400);

  const ticket = await SupportTicket.findById(id).populate("tenant_id", "name slug");
  if (!ticket) throw appError("Ticket not found", 404);

  return ticket;
};

export const updateStatus = async (id, status, actor) => {
  if (!["Pending", "In Progress", "Closed"].includes(status)) {
    throw appError("Invalid status", 400);
  }

  const ticket = await SupportTicket.findById(id);
  if (!ticket) throw appError("Ticket not found", 404);

  if (ticket.status !== status) {
    ticket.status = status;
    ticket.timeline.push({ type: "status_change", sender: actor.sender, senderName: actor.senderName, status });
    await ticket.save();
  }

  return ticket;
};

export const updatePriority = async (id, priority) => {
  if (!["Low", "Medium", "High", "Urgent"].includes(priority)) {
    throw appError("Invalid priority", 400);
  }

  const ticket = await SupportTicket.findById(id);
  if (!ticket) throw appError("Ticket not found", 404);

  ticket.priority = priority;
  await ticket.save();
  return ticket;
};

export const addTenantMessage = async (id, tenantId, { senderName, text }) => {
  const ticket = await SupportTicket.findById(id);
  if (!ticket) throw appError("Ticket not found", 404);
  if (ticket.tenant_id.toString() !== tenantId.toString()) {
    throw appError("Not authorized to access this ticket", 403);
  }

  return appendMessage(ticket, { sender: "tenant", senderName, text });
};

export const addPlatformMessage = async (id, { senderName, text }) => {
  const ticket = await SupportTicket.findById(id);
  if (!ticket) throw appError("Ticket not found", 404);

  return appendMessage(ticket, { sender: "platform", senderName, text });
};
