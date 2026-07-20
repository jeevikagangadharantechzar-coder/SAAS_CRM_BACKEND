import mongoose from "mongoose";
import { masterConn } from "../../config/masterDB.js";

// A single entry in the ticket's timeline — either a message from either side
// of the conversation, or a record of a status change. Keeping both in one
// ordered array (instead of a single overwritable `reply` field) is what lets
// the platform owner and tenant admin go back and forth without either side's
// text clobbering the other's.
const timelineEntrySchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["message", "status_change"], default: "message" },
    sender: { type: String, enum: ["tenant", "platform"], required: true },
    senderName: { type: String, required: true },
    text: { type: String, default: "" },
    status: { type: String, enum: ["Pending", "In Progress", "Closed"] },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

const supportTicketSchema = new mongoose.Schema(
  {
    tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },

    // Denormalized — the tenant admin's User doc lives in the tenant's own DB
    // (a different Mongoose connection), so it can't be populated from here.
    submittedByName:  { type: String, required: true },
    submittedByEmail: { type: String, required: true },

    subject: { type: String, required: true, trim: true },
    priority: { type: String, enum: ["Low", "Medium", "High", "Urgent"], default: "Medium" },

    attachmentPath: { type: String, default: "" },
    attachmentName: { type: String, default: "" },

    status: { type: String, enum: ["Pending", "In Progress", "Closed"], default: "Pending" },
    timeline: { type: [timelineEntrySchema], default: [] },
  },
  { timestamps: true }
);

const SupportTicket = masterConn.model("SupportTicket", supportTicketSchema);
export default SupportTicket;
