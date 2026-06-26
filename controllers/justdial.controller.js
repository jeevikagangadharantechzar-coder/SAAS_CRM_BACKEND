import { getTenantModels } from "../models/tenant/index.js";

export default {
  /**
   * GET/POST /:tenantSlug/api/justdial/webhook
   * Webhook to receive leads from Justdial.
   * Justdial typically sends data in query params (GET) or form data (POST).
   */
  receiveWebhook: async (req, res) => {
    try {
      // Justdial can send data via GET query parameters or POST body
      const data = Object.keys(req.query).length > 0 ? req.query : req.body;

      if (!data || Object.keys(data).length === 0) {
        return res.status(400).json({ success: false, message: "No data received" });
      }

      console.log(` Justdial lead received for tenant ${req.tenant?.slug || "unknown"}:`, data);

      const { Lead } = getTenantModels(req.tenantDB);

      // Map Justdial fields to CRM fields.
      // Adjust these keys based on Justdial's exact payload format.
      const name = data.name || data.lead_name || "Justdial Lead";
      const mobile = data.mobile || data.phone || data.contact || "N/A";
      const email = data.email || data.email_id || "";
      const city = data.city || data.location || data.area || "";
      const category = data.category || data.requirement || "";

      // Look for an existing Justdial lead with the same phone number to avoid duplicates
      if (mobile && mobile !== "N/A") {
        const existingLead = await Lead.findOne({
          phoneNumber: mobile,
          source: "Justdial",
        });

        if (existingLead) {
          console.log(` Justdial Lead with phone ${mobile} already exists — skipping`);
          return res.status(200).json({ success: true, message: "Duplicate lead ignored" });
        }
      }

      // Create new Lead
      const newLead = await Lead.create({
        leadName: name,
        phoneNumber: mobile,
        email: email,
        companyName: name, // Fallback company name
        source: "Justdial",
        status: "Cold",
        address: city,
        requirement: category,
        notes: `Auto-captured from Justdial integration.\nCity: ${city}\nCategory: ${category}\nRaw Data: ${JSON.stringify(data)}`,
      });

      console.log(`Justdial Lead created successfully: ${name} (${mobile})`);
      return res.status(200).json({ success: true, message: "Lead captured successfully", leadId: newLead._id });
    } catch (error) {
      console.error("Justdial webhook error:", error.message);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  }
};
