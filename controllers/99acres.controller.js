import { getTenantModels } from "../models/tenant/index.js";

export default {
  /**
   * GET/POST /:tenantSlug/api/99acres/webhook
   * Webhook to receive leads from 99acres.
   * 99acres typically sends data via JSON POST or form data.
   */
  receiveWebhook: async (req, res) => {
    try {
      const data = Object.keys(req.query).length > 0 ? req.query : req.body;

      if (!data || Object.keys(data).length === 0) {
        return res.status(400).json({ success: false, message: "No data received" });
      }

      console.log(` 99acres lead received for tenant ${req.tenant?.slug || "unknown"}:`, data);

      const { Lead } = getTenantModels(req.tenantDB);

      // Map 99acres fields to CRM fields.
      const name = data.name || data.Contact_Name || data.lead_name || "99acres Lead";
      const mobile = data.mobile || data.Contact_Number || data.phone || data.contact || "N/A";
      const email = data.email || data.Email_Address || data.email_id || "";
      const city = data.city || data.location || data.area || data.City || "";
      const category = data.category || data.requirement || data.Project_Name || data.property_type || "";

      // Look for an existing 99acres lead with the same phone number to avoid duplicates
      if (mobile && mobile !== "N/A") {
        const existingLead = await Lead.findOne({
          phoneNumber: mobile,
          source: "99acres",
        });

        if (existingLead) {
          console.log(` 99acres Lead with phone ${mobile} already exists — skipping`);
          return res.status(200).json({ success: true, message: "Duplicate lead ignored" });
        }
      }

      // Create new Lead
      const newLead = await Lead.create({
        leadName: name,
        phoneNumber: mobile,
        email: email,
        companyName: name, // Fallback company name
        source: "99acres",
        status: "Cold",
        address: city,
        requirement: category,
        notes: `Auto-captured from 99acres integration.\nCity: ${city}\nCategory/Project: ${category}\nRaw Data: ${JSON.stringify(data)}`,
      });

      console.log(`99acres Lead created successfully: ${name} (${mobile})`);
      return res.status(200).json({ success: true, message: "Lead captured successfully", leadId: newLead._id });
    } catch (error) {
      console.error("99acres webhook error:", error.message);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  }
};
