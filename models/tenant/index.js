import userSchema          from "../schemas/userSchema.js";
import roleSchema          from "../schemas/roleSchema.js";
import leadSchema          from "../schemas/leadSchema.js";
import dealSchema          from "../schemas/dealSchema.js";
import activitySchema      from "../schemas/activitySchema.js";
import invoiceSchema       from "../schemas/invoiceSchema.js";
import proposalSchema      from "../schemas/proposalSchema.js";
import callLogSchema       from "../schemas/callLogSchema.js";
import notificationSchema  from "../schemas/notificationSchema.js";
import gmailTokenSchema    from "../schemas/gmailTokenSchema.js";
import whatsappMsgSchema   from "../schemas/whatsappMessageSchema.js";
import clientLTVSchema     from "../schemas/clientLTVSchema.js";
import supportTicketSchema from "../schemas/supportTicketSchema.js";
import clientReviewSchema  from "../schemas/clientReviewSchema.js";
import streakSchema        from "../schemas/streakSchema.js";
import settingsSchema      from "../schemas/settingsSchema.js";
import emailTemplateSchema from "../schemas/emailTemplateSchema.js";
import massEmailSchema      from "../schemas/massEmailSchema.js";
import lostDealReasonSchema from "../schemas/lostDealReasonSchema.js";
import pricingRiskSchema    from "../schemas/pricingRiskSchema.js";
import aiChatSchema        from "../schemas/aiChatSchema.js";
import botHistorySchema         from "../schemas/botHistorySchema.js";
import metaIntegrationSchema    from "../schemas/metaIntegrationSchema.js";
import linkedinIntegrationSchema from "../schemas/linkedinIntegrationSchema.js";
import contactFormSchema         from "../schemas/contactFormSchema.js";
import taskSchema               from "../schemas/taskSchema.js";
import targetSchema             from "../schemas/targetSchema.js";
import indiaMartIntegrationSchema from "../schemas/indiaMartIntegrationSchema.js";
import auditLogSchema from "../schemas/auditLogSchema.js";
import meetingSchema             from "../schemas/meetingSchema.js";
import googleIntegrationSchema   from "../schemas/googleIntegrationSchema.js";
import zoomIntegrationSchema     from "../schemas/zoomIntegrationSchema.js";
import deviceSessionSchema       from "../schemas/deviceSessionSchema.js";
import userLocationSchema        from "../schemas/userLocationSchema.js";


const MODEL_MAP = [
  ["User",             userSchema],
  ["Role",             roleSchema],
  ["Lead",             leadSchema],
  ["Deal",             dealSchema],
  ["Activity",         activitySchema],
  ["Invoice",          invoiceSchema],
  ["Proposal",         proposalSchema],
  ["CallLog",          callLogSchema],
  ["Notification",     notificationSchema],
  ["GmailToken",       gmailTokenSchema],
  ["WhatsappMessage",  whatsappMsgSchema],
  ["ClientLTV",        clientLTVSchema],
  ["SupportTicket",    supportTicketSchema],
  ["ClientReview",     clientReviewSchema],
  ["Streak",           streakSchema],
  ["Settings",         settingsSchema],
  ["EmailTemplate",    emailTemplateSchema],
  ["MassEmail",        massEmailSchema],
  ["LostDealReason",   lostDealReasonSchema],
  ["PricingRisk",      pricingRiskSchema],
  ["AiChat",           aiChatSchema],
  ["BotHistory",       botHistorySchema],
  ["MetaIntegration",  metaIntegrationSchema],
  ["LinkedInIntegration", linkedinIntegrationSchema],
  ["ContactForm",      contactFormSchema],
  ["Task",               taskSchema],
  ["Target",             targetSchema],
  ["IndiaMartIntegration", indiaMartIntegrationSchema],
  ["AuditLog",             auditLogSchema],
  ["Meeting",             meetingSchema],
  ["GoogleIntegration",  googleIntegrationSchema],
  ["ZoomIntegration",    zoomIntegrationSchema],
  ["DeviceSession",      deviceSessionSchema],
  ["UserLocation",       userLocationSchema],
];

/**
 * Register all 17 tenant models on the given Mongoose connection.
 * Safe to call multiple times — skips already-registered models.
 */
export function registerTenantModels(conn) {
  const existing = conn.modelNames();
  for (const [name, schema] of MODEL_MAP) {
    if (!existing.includes(name)) {
      conn.model(name, schema);
    }
  }
}

/**
 * Return a map of all 17 tenant models from the given connection.
 * Call registerTenantModels(conn) before this if the connection is new.
 */
export function getTenantModels(conn) {
  return {
    User:            conn.model("User"),
    Role:            conn.model("Role"),
    Lead:            conn.model("Lead"),
    Deal:            conn.model("Deal"),
    Activity:        conn.model("Activity"),
    Invoice:         conn.model("Invoice"),
    Proposal:        conn.model("Proposal"),
    CallLog:         conn.model("CallLog"),
    Notification:    conn.model("Notification"),
    GmailToken:      conn.model("GmailToken"),
    WhatsappMessage: conn.model("WhatsappMessage"),
    ClientLTV:       conn.model("ClientLTV"),
    SupportTicket:   conn.model("SupportTicket"),
    ClientReview:    conn.model("ClientReview"),
    Streak:          conn.model("Streak"),
    Settings:        conn.model("Settings"),
    EmailTemplate:   conn.model("EmailTemplate"),
    MassEmail:       conn.model("MassEmail"),
    LostDealReason:  conn.model("LostDealReason"),
    PricingRisk:     conn.model("PricingRisk"),
    AiChat:           conn.model("AiChat"),
    BotHistory:       conn.model("BotHistory"),
    MetaIntegration:  conn.model("MetaIntegration"),
    LinkedInIntegration: conn.model("LinkedInIntegration"),
    ContactForm:     conn.model("ContactForm"),
    Task:                conn.model("Task"),
    Target:              conn.model("Target"),
    IndiaMartIntegration: conn.model("IndiaMartIntegration"),
    AuditLog:             conn.model("AuditLog"),
    Meeting:             conn.model("Meeting"),
    GoogleIntegration:   conn.model("GoogleIntegration"),
    ZoomIntegration:     conn.model("ZoomIntegration"),
    DeviceSession:       conn.model("DeviceSession"),
    UserLocation:        conn.model("UserLocation"),
  };
}
