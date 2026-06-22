import mongoose from "mongoose";

const supportTicketSchema = new mongoose.Schema(
  {
    ticketNumber: { type: String, unique: true },
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true }, 
    companyName: { type: String, required: true },
    dealId: { type: mongoose.Schema.Types.ObjectId, ref: "Deal" },
    subject: { type: String, required: true },
    description: { type: String, required: true },
    priority: {
      type: String,
      enum: ["Low", "Medium", "High", "Critical"],
      default: "Medium",
    },
    status: {
      type: String,
      enum: ["Open", "Closed"],
      default: "Open",
    },
    category: {
      type: String,
      enum: ["Technical", "Billing", "Feature Request", "Bug", "General", "Other"],
      default: "General",
    },
    openedAt: { type: Date, default: Date.now },
    closedAt: Date,
    resolutionTimeHours: Number,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

// Auto-generate ticket number before saving
supportTicketSchema.pre("save", async function (next) {
  if (!this.ticketNumber) {
    const date = new Date();
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, "0");
    const count = await mongoose.model("SupportTicket").countDocuments();
    this.ticketNumber = `TKT-${year}${month}-${(count + 1).toString().padStart(4, "0")}`;
  }
  next();
});

const SupportTicket = mongoose.model("SupportTicket", supportTicketSchema);
export default SupportTicket;