import jwt from "jsonwebtoken";
import dotenv from "dotenv";

import { getTenantDB } from "../config/tenantDB.js";
import { getTenantModels } from "../models/tenant/index.js";
import Tenant from "../models/master/Tenant.js";

// Legacy single-tenant imports — still used when req.tenantDB is absent
import UserLegacy from "../models/user.model.js";
import LeadLegacy from "../models/leads.model.js";
import DealLegacy from "../models/deals.model.js";

dotenv.config();

export const protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization?.startsWith("Bearer")) {
    token = req.headers.authorization.split(" ")[1];
  }

  if (!token) {
    return res.status(401).json({ message: "Not authorized, no token" });
  }

  try {
    const decoded = jwt.verify(token, process.env.SECRET_KEY);

    // Resolve tenantDB from token payload if not already set by resolveTenant
    if (!req.tenantDB && decoded.dbName) {
      req.tenantDB = await getTenantDB(decoded.dbName);
    }

    const User = req.tenantDB
      ? getTenantModels(req.tenantDB).User
      : UserLegacy;

    req.user = await User.findById(decoded.id).populate("role");

    if (!req.user) {
      return res.status(401).json({ message: "User not found" });
    }

    // Check subscription plan expiration
    let tenant = req.tenant;
    if (!tenant && decoded.tenantId) {
      tenant = await Tenant.findById(decoded.tenantId);
    } else if (!tenant && decoded.dbName) {
      tenant = await Tenant.findOne({ dbName: decoded.dbName });
    }

    if (tenant && tenant.plan_end_date && new Date() > new Date(tenant.plan_end_date)) {
      const isTrial = tenant.plan_status === "trial";
      return res.status(401).json({
        message: isTrial
          ? "Your 14 days free trial has ended. Please upgrade your plan to continue using the CRM."
          : "Subscription expired. Access restricted.",
        trialExpired: isTrial,
        planExpired: true,
      });
    }

    // Verify token version matches database version to support logout invalidation
    const expectedVersion = req.user.tokenVersion || 0;
    const tokenVersion = decoded.tokenVersion || 0;
    if (tokenVersion !== expectedVersion) {
      return res.status(401).json({ message: "Token expired or invalidated" });
    }

    next();
  } catch (err) {
    return res.status(401).json({ message: "Token failed" });
  }
};

export const adminOnly = (req, res, next) => {
  const roleName = req.user.role.name?.toLowerCase();
  if (roleName !== "admin" && roleName !== "sales") {
    return res.status(403).json({ message: "Access denied: Admins only" });
  }
  next();
};

export const adminCreateOnly = (req, res, next) => {
  const roleName = req.user.role.name?.toLowerCase();
  if (roleName !== "admin") {
    return res.status(403).json({ message: "Access denied: Admins only" });
  }
  next();
};

export const adminOrAssigned = async (req, res, next) => {
  try {
    const roleName = req.user.role.name?.toLowerCase();

    const Lead = req.tenantDB
      ? getTenantModels(req.tenantDB).Lead
      : LeadLegacy;

    const leadId = req.params.id;
    const lead   = await Lead.findById(leadId);

    if (!lead) {
      return res.status(404).json({ message: "Lead not found" });
    }

    // Rejected/Converted leads are terminal — read-only for everyone, Admin
    // included — except DELETE, which Admin can always use to permanently
    // remove a rejected lead (e.g. from the dedicated Rejected Leads page).
    const isTerminal = lead.status === "Rejected" || lead.status === "Converted";
    const isAdminDelete = roleName === "admin" && req.method === "DELETE";
    if (isTerminal && req.method !== "GET" && !isAdminDelete) {
      return res.status(403).json({
        message: `This lead is ${lead.status.toLowerCase()} and can no longer be edited.`,
      });
    }

    if (roleName === "admin") return next();

    if (lead.assignTo && lead.assignTo.toString() === req.user._id.toString()) {
      // Disabled (overdue, pending admin reassignment) leads are read-only for
      // the sales person — GET is fine, any write is blocked until reassigned.
      if (lead.isActive === false && req.method !== "GET") {
        return res.status(403).json({
          message: "This lead is disabled pending admin reassignment.",
        });
      }
      return next();
    }

    return res.status(403).json({
      message: "Access denied: You can only access leads assigned to you",
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const adminOrAssignedToDeal = async (req, res, next) => {
  try {
    const roleName = req.user.role.name?.toLowerCase();

    const Deal = req.tenantDB
      ? getTenantModels(req.tenantDB).Deal
      : DealLegacy;

    const dealId = req.params.id;
    const deal   = await Deal.findById(dealId);

    if (!deal) {
      return res.status(404).json({ message: "Deal not found" });
    }

    // Rejected/Closed Won deals are terminal — read-only for everyone, Admin
    // included — except DELETE, which Admin can always use to permanently
    // remove a rejected deal (e.g. from the dedicated Reject Deals page).
    const isTerminal = deal.stage === "Rejected" || deal.stage === "Closed Won";
    const isAdminDelete = roleName === "admin" && req.method === "DELETE";
    if (isTerminal && req.method !== "GET" && !isAdminDelete) {
      return res.status(403).json({
        message: `This deal is ${deal.stage.toLowerCase()} and can no longer be edited.`,
      });
    }

    if (roleName === "admin") return next();

    if (deal.assignedTo && deal.assignedTo.toString() === req.user._id.toString()) {
      // Disabled (overdue, pending admin reassignment) deals are read-only for
      // the sales person — GET is fine, any write is blocked until reassigned.
      if (deal.isActive === false && req.method !== "GET") {
        return res.status(403).json({
          message: "This deal is disabled pending admin reassignment.",
        });
      }
      return next();
    }

    return res.status(403).json({
      message: "Access denied: You can only access deals assigned to you",
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const adminOrSales = (req, res, next) => {
  const roleName = req.user.role.name?.toLowerCase();
  if (roleName === "admin" || roleName === "sales") return next();
  return res.status(403).json({ message: "Access denied: Admins or Sales only" });
};

export const adminOrSelf = (req, res, next) => {
  const roleName = req.user.role.name?.toLowerCase();
  if (roleName === "admin" || req.user._id.toString() === req.params.id) return next();
  return res.status(403).json({ message: "Access denied" });
};
