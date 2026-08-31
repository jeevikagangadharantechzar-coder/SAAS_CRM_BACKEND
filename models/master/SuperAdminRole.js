import mongoose from "mongoose";
import { masterConn } from "../../config/masterDB.js";

const permissionsSchema = new mongoose.Schema(
  {
    dashboard:           { type: Boolean, default: false },
    tenants:             { type: Boolean, default: false },
    free_trials:         { type: Boolean, default: false },
    analysis:            { type: Boolean, default: false },
    upgrade_requests:    { type: Boolean, default: false },
    support_tickets:     { type: Boolean, default: false },
    subscription_plans:  { type: Boolean, default: false },
    settings:            { type: Boolean, default: false },
    software_enquiries:  { type: Boolean, default: false },
    admin_users:         { type: Boolean, default: false },
  },
  { _id: false }
);

const superAdminRoleSchema = new mongoose.Schema(
  {
    name:        { type: String, required: true, unique: true, trim: true },
    description: { type: String, trim: true, default: "" },
    permissions: { type: permissionsSchema, default: () => ({}) },
  },
  { timestamps: true }
);

const SuperAdminRole = masterConn.model("SuperAdminRole", superAdminRoleSchema);
export default SuperAdminRole;
