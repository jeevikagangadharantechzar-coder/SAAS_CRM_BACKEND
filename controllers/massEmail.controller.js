import { getTenantModels } from "../models/tenant/index.js";

// Legacy fallbacks
import MassEmailLegacy from "../models/massEmail.model.js";
import LeadLegacy      from "../models/leads.model.js";
import DealLegacy      from "../models/deals.model.js";
import SettingsLegacy  from "../models/Settings.js";

import fs from "fs";
import path from "path";
import sendEmail from "../utils/sendEmail.js";
import { addEmailToQueue } from "../utils/emailQueue.js";
import { sendEmailWithAttachments } from "../utils/gmailService.js";

const getModels = (req) => {
  if (req.tenantDB) return getTenantModels(req.tenantDB);
  return { MassEmail: MassEmailLegacy, Lead: LeadLegacy, Deal: DealLegacy };
};

const getSettings = (req) =>
  req.tenantDB ? getTenantModels(req.tenantDB).Settings : SettingsLegacy;

export default {

// Get all contacts (leads + deals) for mass email - no pagination
getAllEmailContacts: async (req, res) => {
  try {
    const { Lead, Deal } = getModels(req);

    // Fetch all leads with email
    const leads = await Lead.find({ email: { $exists: true, $ne: "" } })
      .select("leadName name email phoneNumber phone companyName company status source createdAt")
      .lean();

    // Fetch all deals with email
    const deals = await Deal.find({
      $or: [
        { email: { $exists: true, $ne: "" } },
        { leadEmail: { $exists: true, $ne: "" } }
      ]
    })
      .populate("leadId", "email leadName phoneNumber companyName")
      .select("dealName leadName email leadEmail phoneNumber phone companyName company stage source createdAt leadId")
      .lean();

    const contacts = [];

    // Format leads
    for (const lead of leads) {
      if (!lead.email) continue;
      contacts.push({
        id: lead._id,
        name: lead.leadName || lead.name || "",
        email: lead.email,
        phone: lead.phoneNumber || lead.phone || "",
        company: lead.companyName || lead.company || "",
        type: "lead",
        status: lead.status || "",
        source: "Leads",
        createdAt: lead.createdAt,
        displayId: `lead-${lead._id}`
      });
    }

    // Format deals
    for (const deal of deals) {
      const email = deal.email || deal.leadEmail || deal.leadId?.email || "";
      if (!email) continue;
      contacts.push({
        id: deal._id,
        name: deal.dealName || deal.leadName || deal.leadId?.leadName || "",
        email,
        phone: deal.phoneNumber || deal.phone || deal.leadId?.phoneNumber || "",
        company: deal.companyName || deal.company || deal.leadId?.companyName || "",
        type: "deal",
        status: deal.stage || "Deal",
        source: "Deals",
        createdAt: deal.createdAt,
        displayId: `deal-${deal._id}`
      });
    }

    res.json({ success: true, data: contacts, total: contacts.length });

  } catch (error) {
    console.error("Get email contacts error:", error);
    res.status(500).json({ message: "Failed to fetch contacts" });
  }
},
//send email to multiple clients
sendBulkEmail : async (req, res) => {
  try {
    const { MassEmail } = getModels(req);
    let { recipients, templateTitle, subject, content, scheduledFor } = req.body;

    //  Handle single recipient case (FormData sends string if only 1)
    if (!Array.isArray(recipients)) {
      recipients = [recipients];
    }

    if (!recipients || recipients.length === 0) {
      return res.status(400).json({ message: "Recipients are required" });
    }

    if (!subject || !content) {
      return res
        .status(400)
        .json({ message: "Subject and content are required" });
    }

    // Fetch tenant settings for dynamic logo + company name
    const Settings = getSettings(req);
    const settings = await Settings.findOne();
    const companyName = settings?.companyName || req.tenant?.name || "CRM Software";

    // Embed logo via CID attachment — base64 data URIs are blocked by Gmail
    let logoBlock = "";
    const logoRelPath = settings?.invoiceLogo || settings?.logo;
    let logoCIDAttachment = null;
    if (logoRelPath) {
      const logoPath = path.join(process.cwd(), logoRelPath);
      if (fs.existsSync(logoPath)) {
        const logoExt = path.extname(logoPath) || ".png";
        logoCIDAttachment = { filename: `logo${logoExt}`, path: logoPath, cid: "bulk-email-logo", contentDisposition: "inline" };
        logoBlock = `<div style="text-align:center; margin-bottom:25px;"><img src="cid:bulk-email-logo" alt="${companyName}" style="max-height:80px; width:auto;" /></div>`;
      }
    }

    //  Prepare attachments from multer
    const files = req.files || [];

    const attachments = files.map((file) => ({
      filename: file.originalname,
      path: file.path,
    }));

    if (logoCIDAttachment) attachments.push(logoCIDAttachment);

    // withLogo is only usable on the shared-mailbox path below — the tenant
    // Gmail-API path has no inline/cid image support, so it sends without
    // the logo rather than showing a broken image.
    const buildHTML = (withLogo) => `
      <div style="background-color:#f4f6f8; padding:40px 0;">
        <div style="max-width:600px; margin:auto; background:white; padding:30px; border-radius:8px;">

          ${withLogo ? logoBlock : ""}

          <div style="font-size:14px; line-height:1.6; color:#333;">
            ${content}
          </div>

          <hr style="margin:30px 0; border:none; border-top:1px solid #eee;" />

          <div style="text-align:center; font-size:12px; color:#888;">
            © ${new Date().getFullYear()} ${companyName}. All rights reserved.
          </div>

        </div>
      </div>
    `;

    //  Save email in DB first
    const newEmail = await MassEmail.create({
      recipients,
      templateTitle,
      subject,
      content,
      attachments,
      scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
      status: scheduledFor ? "scheduled" : "pending",
      createdBy: req.user._id,
    });

    //  If NO scheduled date → send immediately
    if (!scheduledFor) {
      if (settings?.invoiceSenderEmail) {
        // Tenant connected their own Gmail via OAuth — send genuinely as that
        // account, same as invoice and proposal emails, instead of the
        // shared mailbox.
        const gmailAttachments = files.map((file) => ({
          filename: file.originalname,
          content: fs.readFileSync(file.path).toString("base64"),
          mimetype: file.mimetype,
          size: file.size,
        }));
        for (const email of recipients) {
          await sendEmailWithAttachments(email, subject, buildHTML(false), "", "", gmailAttachments, [], settings.invoiceSenderEmail);
        }
      } else {
        for (const email of recipients) {
          await addEmailToQueue({
            to: email,
            subject,
            html: buildHTML(true),
            attachments,
          });
        }
      }

      // Update status to sent
      newEmail.status = "sent";
      await newEmail.save();
    }
      res.json({
      success: true,
      message: scheduledFor
        ? "Email scheduled successfully"
        : "Bulk emails sent successfully",
    });


  } catch (err) {
    console.error("Bulk email error:", err);
    res.status(500).json({ message: "Failed to send bulk emails" });
  }
},
//// Get paginated history of sent emails with role-based access
getEmailHistory : async (req, res) => {
  try {
    const { MassEmail } = getModels(req);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 5;
    const skip = (page - 1) * limit;

    let filter = { status: "sent" };

    // If NOT Admin → show only their emails
    if (req.user.role.name !== "Admin") {
      filter.createdBy = req.user._id;
    }

    const total = await MassEmail.countDocuments(filter);

    let query = MassEmail.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);
    
    // If Admin, populate the createdBy field with user details
    if (req.user.role.name === "Admin") {
      query = query.populate("createdBy", "firstName lastName email");
    }

    const emails = await query;

    res.json({
      success: true,
      data: emails,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });

  } catch (error) {
    console.error("History error:", error);
    res.status(500).json({ message: "Failed to fetch history" });
  }
},
// Get all scheduled emails with role-based access
getScheduledEmails : async (req, res) => {
  try {
    const { MassEmail } = getModels(req);
    let filter = { status: "scheduled" };

    // If NOT Admin → show only their scheduled emails
    if (req.user.role.name !== "Admin") {
      filter.createdBy = req.user._id;
    }

    let query = MassEmail.find(filter).sort({ scheduledFor: 1 });
    
    // If Admin, populate the createdBy field with user details
    if (req.user.role.name === "Admin") {
      query = query.populate("createdBy", "firstName lastName email");
    }

    const emails = await query;

    res.json({
      success: true,
      data: emails,
    });

  } catch (error) {
    console.error("Scheduled fetch error:", error);
    res.status(500).json({ message: "Failed to fetch scheduled emails" });
  }
},
//cancel the scheduled email
cancelScheduledEmail : async (req, res) => {
  try {
    const { MassEmail } = getModels(req);
    const emailId = req.params.id;

    const email = await MassEmail.findById(emailId);

    if (!email) {
      return res.status(404).json({ message: "Email not found" });
    }

    if (email.status !== "scheduled") {
      return res.status(400).json({
        message: "Only scheduled emails can be cancelled",
      });
    }

    email.status = "cancelled";
    email.cancelledBy = req.user._id;
    email.cancelledAt = new Date();
    await email.save();

    res.json({
      success: true,
      message: "Scheduled email cancelled successfully",
    });

  } catch (error) {
    console.error("Cancel error:", error);
    res.status(500).json({ message: "Failed to cancel email" });
  }
},
// Get single email by ID
getSingleEmail : async (req, res) => {
  try {
    const { MassEmail } = getModels(req);
    const email = await MassEmail.findById(req.params.id);

    if (!email) {
      return res.status(404).json({ message: "Email not found" });
    }

    res.json({
      success: true,
      data: email,
    });

  } catch (error) {
    console.error("Get single email error:", error);
    res.status(500).json({ message: "Failed to fetch email" });
  }
},
//update the already scheduled email
updateScheduledEmail : async (req, res) => {
  try {
    const { MassEmail } = getModels(req);
    const { subject, content, recipients, scheduledFor, templateTitle } = req.body;
    const { newAttachments, existingAttachments, removedAttachments } = req.body;
    
    // Parse JSON strings if they come as strings
    let existingAttachmentsArray = [];
    let removedAttachmentsArray = [];
    
    if (existingAttachments) {
      existingAttachmentsArray = typeof existingAttachments === 'string' 
        ? JSON.parse(existingAttachments) 
        : existingAttachments;
    }
    
    if (removedAttachments) {
      removedAttachmentsArray = typeof removedAttachments === 'string' 
        ? JSON.parse(removedAttachments) 
        : removedAttachments;
    }

    const email = await MassEmail.findById(req.params.id);

    if (!email) {
      return res.status(404).json({ message: "Email not found" });
    }

    if (email.status !== "scheduled") {
      return res.status(400).json({
        message: "Only scheduled emails can be edited",
      });
    }

    // Handle recipients (could be string or array)
    let recipientsArray = recipients;
    if (typeof recipients === 'string') {
      recipientsArray = [recipients];
    }

    // Handle new attachments from multer
    const files = req.files || [];
    const newAttachmentsArray = files.map((file) => ({
      filename: file.originalname,
      path: file.path,
    }));

    //  DELETE removed attachments from filesystem
    if (removedAttachmentsArray.length > 0) {
      for (const attachment of removedAttachmentsArray) {
        try {
          // Check if file exists and delete it
          if (attachment.path && fs.existsSync(attachment.path)) {
            fs.unlinkSync(attachment.path);
            console.log(`Deleted attachment: ${attachment.path}`);
          }
        } catch (err) {
          console.error("Error deleting attachment file:", err);
          // Continue even if file deletion fails
        }
      }
    }

    //  Combine existing attachments (ones not removed) with new attachments
    const finalAttachments = [
      ...existingAttachmentsArray, // These are the attachments that were kept
      ...newAttachmentsArray,       // These are the newly uploaded ones
    ];

    // Update email fields
    email.subject = subject || email.subject;
    email.content = content || email.content;
    email.recipients = recipientsArray || email.recipients;
    email.templateTitle = templateTitle || email.templateTitle;
    email.attachments = finalAttachments;
    
    if (scheduledFor) {
      email.scheduledFor = new Date(scheduledFor);
    }

    await email.save();

    res.json({
      success: true,
      message: "Scheduled email updated successfully",
      data: email,
    });

  } catch (error) {
    console.error("Update error:", error);
    res.status(500).json({ message: "Failed to update email" });
  }
},
//delete Email
deleteEmail : async (req, res) => {
  try {
    const { MassEmail } = getModels(req);
    const email = await MassEmail.findById(req.params.id);

    if (!email) {
      return res.status(404).json({
        success: false,
        message: "Email not found",
      });
    }

    await email.deleteOne();

    res.json({
      success: true,
      message: "Email deleted successfully",
    });

  } catch (error) {
    console.error("Delete email error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete email",
    });
  }
},
//delete email in history
deleteEmailHistory: async (req, res) => {
  try {
    const { MassEmail } = getModels(req);
    const email = await MassEmail.findById(req.params.id);

    if (!email) {
      return res.status(404).json({
        success: false,
        message: "Email not found",
      });
    }

    // Check if user has permission to delete
    if (req.user.role.name !== "Admin" && email.createdBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: "You don't have permission to delete this email",
      });
    }

    // Delete associated attachment files from filesystem
    if (email.attachments && email.attachments.length > 0) {
      for (const attachment of email.attachments) {
        try {
          if (attachment.path && fs.existsSync(attachment.path)) {
            fs.unlinkSync(attachment.path);
            console.log(`Deleted attachment: ${attachment.path}`);
          }
        } catch (err) {
          console.error("Error deleting attachment file:", err);
          // Continue even if file deletion fails
        }
      }
    }

    await email.deleteOne();

    res.json({
      success: true,
      message: "Email deleted successfully",
    });

  } catch (error) {
    console.error("Delete email error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete email",
    });
  }
},
// Add bulk delete function for the history page
bulkDeleteEmailHistory: async (req, res) => {
  try {
    const { MassEmail } = getModels(req);
    const { emailIds, selectAll, filters } = req.body;
    
    // Build the base filter based on user role
    let baseFilter = {};
    
    // If not Admin, only allow deletion of their own emails
    if (req.user.role.name !== "Admin") {
      baseFilter.createdBy = req.user._id;
    }

    let filter = {};
    let deleteMessage = "";

    // CASE 1: Select All across all pages
    if (selectAll) {
      filter = { ...baseFilter, status: "sent" }; // Only allow deleting sent emails
      deleteMessage = "All emails";
      
      // Apply any additional filters if provided (for future use)
      if (filters) {
        filter = { ...filter, ...filters };
      }
    } 
    // CASE 2: Delete specific emails by IDs
    else {
      if (!emailIds || !Array.isArray(emailIds) || emailIds.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Email IDs are required when not using select all",
        });
      }
      
      filter = { 
        ...baseFilter, 
        _id: { $in: emailIds },
        status: "sent" // Only allow deleting sent emails
      };
      deleteMessage = `${emailIds.length} emails`;
    }

    // Get emails to delete their attachments (with pagination to handle large datasets)
    const batchSize = 100;
    let totalDeleted = 0;
    let processedEmails = [];

    // Process in batches to avoid memory issues with large datasets
    while (true) {
      const emailsBatch = await MassEmail.find(filter)
        .limit(batchSize)
        .skip(totalDeleted)
        .lean();

      if (emailsBatch.length === 0) break;

      // Delete attachments for this batch
      for (const email of emailsBatch) {
        if (email.attachments && email.attachments.length > 0) {
          for (const attachment of email.attachments) {
            try {
              if (attachment.path && fs.existsSync(attachment.path)) {
                fs.unlinkSync(attachment.path);
              }
            } catch (err) {
              console.error("Error deleting attachment file:", err);
            }
          }
        }
      }

      processedEmails = [...processedEmails, ...emailsBatch];
      totalDeleted += emailsBatch.length;
    }

    // Delete the emails in one go using the IDs we collected
    const emailIdsToDelete = processedEmails.map(email => email._id);
    
    if (emailIdsToDelete.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No emails found to delete",
      });
    }

    const result = await MassEmail.deleteMany({
      _id: { $in: emailIdsToDelete }
    });

    res.json({
      success: true,
      message: `Successfully deleted ${result.deletedCount} emails`,
      deletedCount: result.deletedCount,
      selectAllUsed: selectAll || false
    });

  } catch (error) {
    console.error("Bulk delete error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete emails",
    });
  }
},
};
