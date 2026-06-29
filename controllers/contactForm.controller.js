import axios from "axios";
import { getTenantModels } from "../models/tenant/index.js";
import ContactFormLegacy from "../models/ContactForm.js";
import { sendContactFormNotification } from "../services/contactNotification.service.js";

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
