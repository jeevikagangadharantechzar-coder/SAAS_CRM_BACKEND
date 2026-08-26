import axios from "axios";
import { getTenantModels } from "../models/tenant/index.js";
import ContactFormLegacy from "../models/ContactForm.js";
import { sendContactFormNotification } from "../services/contactNotification.service.js";
import { pickNextSalesUser } from "../services/leadAssignment.js";
import { notifyUser } from "../realtime/socket.js";

// Fields mapped to real columns on the ContactForm schema (+ request-only
// fields that never get stored as-is). Anything else a tenant's own form
// sends — every tenant's website has a different field set — is captured
// into customFields instead of being silently dropped.
const KNOWN_CONTACT_FORM_FIELDS = new Set([
  "captchaToken",
  "createAsLead",
  "name",
  "email",
  "phone",
  "companyName",
  "industry",
  "address",
  "country",
  "source",
  "requirement",
  "notes",
  "clientType",
]);

const extractCustomFields = (body) =>
  Object.entries(body || {})
    .filter(([key, value]) => !KNOWN_CONTACT_FORM_FIELDS.has(key) && value !== undefined && value !== null && value !== "")
    .map(([name, value]) => ({
      name,
      value: typeof value === "string" ? value : JSON.stringify(value),
    }));

// Handle contact form submission with captcha verification, 
// file uploads, 
// email notification
const submitContactForm = async (req, res) => {
  console.log(" CONTACT FORM REQ BODY:", req.body);
  try {
    const { captchaToken } = req.body;

    if ((!captchaToken || captchaToken === "null") && process.env.NODE_ENV === "production") {
      return res.status(400).json({
        success: false,
        message: "Captcha verification required",
      });
    }

    const {
      name,
      email,
      phone,
      companyName,
      industry,
      address,
      country,
      source,
      requirement,
      notes,
      clientType,
    } = req.body;
    const attachments = req.files?.map((file) => ({
      name: file.originalname,
      path: `/uploads/leads/${file.filename}`,
      type: file.mimetype,
      size: file.size,
      uploadedAt: new Date(),
    })) || [];

    // Basic validation
    if (!name || !email || !phone) {
      return res.status(400).json({
        success: false,
        message: "Name, email and Phone Number are required",
      });
    }

    try {
      if (process.env.NODE_ENV !== "production") {
        // Bypass captcha for local testing
        console.log("Bypassing captcha for local testing");
      } else {
        const verificationURL = "https://www.google.com/recaptcha/api/siteverify";
        const response = await axios.post(
          verificationURL,
          null,
          {
            params: {
              secret: process.env.RECAPTCHA_SECRET_KEY,
              response: captchaToken,
            },
          }
        );

        if (!response.data.success) {
          console.error("Captcha failed:", response.data);
          return res.status(400).json({
            success: false,
            message: "Captcha verification failed",
          });
        }
      }
    } catch (error) {
      console.error("Captcha error:", error);
      return res.status(500).json({
        success: false,
        message: "Captcha verification error",
      });
    }

    const customFields = extractCustomFields(req.body);
    // Also inferred from source (not just the explicit flag) so a stale/cached
    // frontend bundle that hasn't picked up the createAsLead field yet still
    // gets routed straight to the Lead table instead of silently falling back
    // to the ContactForm review queue.
    const createAsLead =
      req.body.createAsLead === true ||
      req.body.createAsLead === "true" ||
      source === "Software Enquiry";

    // Some callers (e.g. the software-enquiry marketing form) want the
    // submission to land straight in the tenant's Lead table — visible in
    // the regular CRM Leads list immediately — instead of the ContactForm
    // holding area that waits for an admin to review and manually convert it.
    // Mirrors how meta.controller.js creates Facebook/Instagram leads directly.
    if (createAsLead && req.tenantDB) {
      const { Lead, User, Role } = getTenantModels(req.tenantDB);
      const assignTo = await pickNextSalesUser(User, Lead);

      const lead = await Lead.create({
        leadName: name,
        email,
        phoneNumber: phone,
        companyName,
        industry,
        address,
        country,
        source: source || "Website",
        requirement,
        notes,
        clientType,
        attachments,
        customFields,
        assignTo,
      });

      try {
        const adminRole = await Role.findOne({ name: { $regex: /^admin$/i } });
        if (adminRole) {
          const admins = await User.find({ role: adminRole._id, status: "Active" }).select("_id").lean();
          const payload = { leadId: String(lead._id), leadName: lead.leadName, source: lead.source };
          admins.forEach((a) => notifyUser(String(a._id), "lead_created", payload));
        }
      } catch (notifyErr) {
        console.error("Lead-created socket notification error:", notifyErr.message);
      }

      return res.status(201).json({
        success: true,
        message: "Thanks — we'll get back to you within one business day.",
        data: { id: lead._id },
      });
    }

    // Save to DB
    const ContactForm = req.tenantDB ? getTenantModels(req.tenantDB).ContactForm : ContactFormLegacy;
    const contact = await ContactForm.create({
      name,
      email,
      phone,
      companyName,
      industry,
      address,
      country,
      source: source || "Website",
      requirement,
      notes,
      clientType,
      attachments,
      customFields,
    });

    //  Send CRM notification
    console.log(" NOTIFICATION: About to send notification");

    await sendContactFormNotification({
      tenant: req.tenant, // Pass tenant if notification service needs it
      text: "New website contact form submitted",
      meta: {
        contactFormId: contact._id,
        name: contact.name,
        email: contact.email,
        phone: contact.phone,
        companyName: contact.companyName,
        industry: contact.industry,
        address: contact.address,
        country: contact.country,
        source: contact.source,
        requirement: contact.requirement,
        notes: contact.notes,
        clientType: contact.clientType,
        attachments: contact.attachments,
        customFields: contact.customFields,
      },
    });
    console.log(" NOTIFICATION: Sent successfully");

    return res.status(201).json({
      success: true,
      message: "Contact form submitted successfully",
      data: {
        id: contact._id,
      },
    });
  } catch (error) {
    console.error("Contact form error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
};

export default {
  submitContactForm
};
