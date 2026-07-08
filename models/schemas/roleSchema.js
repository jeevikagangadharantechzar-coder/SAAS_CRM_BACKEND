import mongoose from "mongoose";

const permissionsSchema = new mongoose.Schema(
  {
    dashboard:           { type: Boolean, default: false },
    leads:               { type: Boolean, default: false },
    create_lead:         { type: Boolean, default: false },
    deals_all:           { type: Boolean, default: false },
    create_deal:         { type: Boolean, default: false },
    deals_pipeline:      { type: Boolean, default: false },
    invoices:            { type: Boolean, default: false },
    proposal:            { type: Boolean, default: false },
    activities:          { type: Boolean, default: false },
    activities_calendar: { type: Boolean, default: false },
    activities_list:     { type: Boolean, default: false },
    users_roles:         { type: Boolean, default: false },
    admin_access:        { type: Boolean, default: false },
    email_chat:          { type: Boolean, default: false },
    email_campaigns:     { type: Boolean, default: false },
    whatsapp_chat:       { type: Boolean, default: false },
    reports:             { type: Boolean, default: false },
    settings:            { type: Boolean, default: false },
    streak_leaderboard:  { type: Boolean, default: false },
    assigned_tasks:      { type: Boolean, default: true },
    task_management:     { type: Boolean, default: false },
    target_management:   { type: Boolean, default: false },
    my_targets:          { type: Boolean, default: true },
    meetings:            { type: Boolean, default: false },
    deal_analysis:       { type: Boolean, default: true },
    won_analysis:        { type: Boolean, default: true },
    loss_analysis:       { type: Boolean, default: true },
    messages:            { type: Boolean, default: true },
  },
  { _id: false }
);

const roleSchema = new mongoose.Schema(
  {
    name:        { type: String, required: true, unique: true, trim: true },
    description: { type: String, trim: true },
    permissions: { type: permissionsSchema, default: () => ({}) },
  },
  { timestamps: true }
);

export default roleSchema;
