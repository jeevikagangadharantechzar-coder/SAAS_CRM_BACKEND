import * as supportTicketService from "../services/supportTicket.service.js";
import SuperAdmin from "../models/master/SuperAdmin.js";
import Tenant from "../models/master/Tenant.js";
import { getTenantDB } from "../config/tenantDB.js";
import { getTenantModels } from "../models/tenant/index.js";
import { emitToSuperAdmin } from "../realtime/superAdminSocket.js";
import { notifyUser } from "../realtime/socket.js";

const sendError = (res, err) => {
  return res.status(err.statusCode || 500).json({
    success: false,
    error: err.message,
  });
};

// Pushes the live ticket state to whichever side didn't just make the change,
// so an already-open tab updates on its own instead of needing a refresh.
const notifyTenantAdmin = async (ticket) => {
  try {
    const tenant = await Tenant.findById(ticket.tenant_id);
    if (!tenant) return;

    const tenantDB = await getTenantDB(tenant.dbName);
    const { User } = getTenantModels(tenantDB);
    const admin = await User.findOne({ email: ticket.submittedByEmail });
    if (admin) notifyUser(String(admin._id), "support_ticket_updated", ticket);
  } catch (err) {
    console.error("notifyTenantAdmin error:", err.message);
  }
};

const notifySuperAdmin = async (ticketId) => {
  try {
    const ticket = await supportTicketService.getTicketById(ticketId);
    emitToSuperAdmin("support_ticket_updated", ticket);
  } catch (err) {
    console.error("notifySuperAdmin error:", err.message);
  }
};

// ── Tenant side ──────────────────────────────

export const createTicket = async (req, res) => {
  try {
    const ticket = await supportTicketService.createTicket({
      tenantId: req.tenant._id,
      submittedByName: `${req.user.firstName} ${req.user.lastName}`.trim(),
      submittedByEmail: req.user.email,
      subject: req.body.subject,
      message: req.body.message,
      priority: req.body.priority,
      attachmentPath: req.file ? req.file.path.replace(/\\/g, "/") : "",
      attachmentName: req.file ? req.file.originalname : "",
    });

    notifySuperAdmin(ticket._id);

    return res.status(201).json({ success: true, data: ticket });
  } catch (err) {
    console.error("createTicket error:", err);
    return sendError(res, err);
  }
};

export const getMyTickets = async (req, res) => {
  try {
    const tickets = await supportTicketService.getTicketsForTenant(req.tenant._id);
    return res.status(200).json({ success: true, data: tickets });
  } catch (err) {
    console.error("getMyTickets error:", err);
    return sendError(res, err);
  }
};

export const addTenantMessage = async (req, res) => {
  try {
    const ticket = await supportTicketService.addTenantMessage(req.params.id, req.tenant._id, {
      senderName: `${req.user.firstName} ${req.user.lastName}`.trim(),
      text: req.body.text,
    });

    notifySuperAdmin(ticket._id);

    return res.status(200).json({ success: true, data: ticket });
  } catch (err) {
    console.error("addTenantMessage error:", err);
    return sendError(res, err);
  }
};

// ── Superadmin side ──────────────────────────

export const listTickets = async (req, res) => {
  try {
    const { search, status, priority, dateFrom, dateTo, page = 1, limit = 10 } = req.query;
    const { tickets, total } = await supportTicketService.listTickets({
      search,
      status,
      priority,
      dateFrom,
      dateTo,
      page: parseInt(page),
      limit: parseInt(limit),
    });

    return res.status(200).json({
      success: true,
      data: tickets,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error("listTickets error:", err);
    return sendError(res, err);
  }
};

export const getTicket = async (req, res) => {
  try {
    const ticket = await supportTicketService.getTicketById(req.params.id);
    return res.status(200).json({ success: true, data: ticket });
  } catch (err) {
    console.error("getTicket error:", err);
    return sendError(res, err);
  }
};

export const updateStatus = async (req, res) => {
  try {
    const admin = await SuperAdmin.findById(req.superAdmin.id);
    const ticket = await supportTicketService.updateStatus(req.params.id, req.body.status, {
      sender: "platform",
      senderName: admin?.name || "Techzar Support",
    });

    notifyTenantAdmin(ticket);

    return res.status(200).json({ success: true, data: ticket });
  } catch (err) {
    console.error("updateStatus error:", err);
    return sendError(res, err);
  }
};

export const updatePriority = async (req, res) => {
  try {
    const ticket = await supportTicketService.updatePriority(req.params.id, req.body.priority);

    notifyTenantAdmin(ticket);

    return res.status(200).json({ success: true, data: ticket });
  } catch (err) {
    console.error("updatePriority error:", err);
    return sendError(res, err);
  }
};

export const addPlatformMessage = async (req, res) => {
  try {
    const admin = await SuperAdmin.findById(req.superAdmin.id);
    const ticket = await supportTicketService.addPlatformMessage(req.params.id, {
      senderName: admin?.name || "Techzar Support",
      text: req.body.text,
    });

    notifyTenantAdmin(ticket);

    return res.status(200).json({ success: true, data: ticket });
  } catch (err) {
    console.error("addPlatformMessage error:", err);
    return sendError(res, err);
  }
};
