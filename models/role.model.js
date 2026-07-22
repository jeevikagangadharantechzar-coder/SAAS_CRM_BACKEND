import mongoose from "mongoose";

const permissionsSchema = new mongoose.Schema(
  {
    dashboard: { type: Boolean, default: false },
    leads: { type: Boolean, default: false },
    deals_all: { type: Boolean, default: false },
    deals_pipeline: { type: Boolean, default: false },
    invoices: { type: Boolean, default: false },
    proposal: { type: Boolean, default: false },
    activities: { type: Boolean, default: false },
    activities_calendar: { type: Boolean, default: false },
    activities_list: { type: Boolean, default: false },
    users_roles: { type: Boolean, default: false },
    admin_access: { type: Boolean, default: false },
    email_chat: { type: Boolean, default: false },
    whatsapp_chat: { type: Boolean, default: false },
    reports: { type: Boolean, default: false },
    schedule_view: { type: Boolean, default: true },
    documents: { type: Boolean, default: true },
  },
  { _id: false }
);

const roleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, trim: true },
    permissions: { type: permissionsSchema, default: () => ({}) },
  },
  { timestamps: true }
);

export default mongoose.models.Role || mongoose.model("Role", roleSchema);
