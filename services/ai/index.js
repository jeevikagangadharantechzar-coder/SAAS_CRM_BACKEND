import lostDeals from "./modules/lostDeals.js";
import pricingRisk from "./modules/pricingRisk.js";
import notifications from "./modules/notifications.js";
import meetings from "./modules/meetings.js";
import callLogs from "./modules/callLogs.js";
import activities from "./modules/activities.js";
import supportTickets from "./modules/supportTickets.js";
import catalog from "../../controllers/ai/catalogAi.controller.js";
import assets from "./modules/assets.js";
import documents from "./modules/documents.js";
import emailCampaigns from "./modules/emailCampaigns.js";
import streaks from "./modules/streaks.js";
import clientReviews from "./modules/clientReviews.js";
import groups from "./modules/groups.js";
import messages from "./modules/messages.js";
import agreements from "./modules/agreements.js";
import userLocation from "./modules/userLocation.js";
import salesReport from "./modules/salesReport.js";

export const AI_MODULES = [
  lostDeals,
  pricingRisk,
  notifications,
  meetings,
  callLogs,
  activities,
  supportTickets,
  catalog,
  assets,
  documents,
  emailCampaigns,
  streaks,
  clientReviews,
  groups,
  messages,
  agreements,
  userLocation,
  salesReport,
];

// Returns { intent, message, data } from the first module that answers, or null.
export async function runAiModules(ctx) {
  for (const mod of AI_MODULES) {
    if (!mod.match(ctx)) continue;
    const result = await mod.handle(ctx);
    if (result) return result;
  }
  return null;
}

// Example questions per module, used in Ziya's help reply.
export const AI_HELP_EXAMPLES = [
  "Show my hot leads",
  "Open deals this month",
  "Unpaid invoices",
  "My pending tasks",
  "My active targets",
  "Sent proposals",
  "My meetings today",
  "Missed calls this week",
  "Upcoming activities",
  "Open support tickets",
  "Price of product X",
  "Services for product X",
  "Assets assigned to me",
  "Pending documents",
  "Top reasons for lost deals",
  "Scheduled email campaigns",
  "My streak",
  "Unread WhatsApp messages",
  "Unread notifications",
  "Poor client reviews",
  "High pricing risk deals",
  "My groups",
  "Sales summary this month",
];
