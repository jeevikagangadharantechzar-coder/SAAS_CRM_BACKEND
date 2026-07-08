import { getTenantModels } from "../models/tenant/index.js";
import SettingsLegacy from "../models/Settings.js";
import { generateAuthUrl } from "../utils/gmailService.js";

const getSettings = (req) => req.tenantDB ? getTenantModels(req.tenantDB).Settings : SettingsLegacy;

const isLocalHost = (req) => {
  const host = req.get("host");
  return host?.includes("localhost") || host?.includes("127.0.0.1");
};

export default {
  getSettings: async (req, res) => {
    try {
      const Settings = getSettings(req);
      let settings = await Settings.findOne();
      if (!settings) settings = await Settings.create({});

      const responseData = settings.toObject();
      if (req.tenant) {
        responseData.tenantEmail = req.tenant.adminEmail;
        responseData.tenantName = req.tenant.name;
      }
      res.status(200).json(responseData);
    } catch (error) {
      console.error("Get Settings Error:", error);
      res.status(500).json({ message: "Server Error" });
    }
  },

  updateLogo: async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: "Logo file is required" });
      const Settings = getSettings(req);
      const logoPath = req.file.path.replace(/\\/g, "/");
      let settings = await Settings.findOne();
      if (!settings) settings = new Settings({ logo: logoPath });
      else settings.logo = logoPath;
      await settings.save();
      res.status(200).json({ success: true, message: "Company logo updated successfully", data: settings });
    } catch (error) {
      console.error("Update Logo Error:", error);
      res.status(500).json({ message: "Server Error" });
    }
  },

  updateFavicon: async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: "Favicon file is required" });
      const Settings = getSettings(req);
      const faviconPath = req.file.path.replace(/\\/g, "/");
      let settings = await Settings.findOne();
      if (!settings) settings = new Settings({ favicon: faviconPath });
      else settings.favicon = faviconPath;
      await settings.save();
      res.status(200).json({ success: true, message: "Favicon updated successfully", data: settings });
    } catch (error) {
      console.error("Update Favicon Error:", error);
      res.status(500).json({ message: "Server Error" });
    }
  },

  updateCompanyName: async (req, res) => {
    try {
      const { companyName } = req.body;
      if (!companyName) return res.status(400).json({ message: "Company name is required" });
      const Settings = getSettings(req);
      let settings = await Settings.findOne();
      if (!settings) settings = new Settings({ companyName });
      else settings.companyName = companyName;
      await settings.save();
      res.status(200).json({ success: true, message: "Company name updated successfully", data: settings });
    } catch (error) {
      console.error("Update Company Name Error:", error);
      res.status(500).json({ message: "Server Error" });
    }
  },

  updateInvoiceLogo: async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: "Invoice logo file is required" });
      const Settings = getSettings(req);
      const logoPath = req.file.path.replace(/\\/g, "/");
      let settings = await Settings.findOne();
      if (!settings) settings = new Settings({ invoiceLogo: logoPath });
      else settings.invoiceLogo = logoPath;
      await settings.save();
      res.status(200).json({ success: true, message: "Invoice logo updated successfully", data: settings });
    } catch (error) {
      console.error("Update Invoice Logo Error:", error);
      res.status(500).json({ message: "Server Error" });
    }
  },

  updateBusinessDetails: async (req, res) => {
    try {
      const { address, phone, email, taxIdLabel, taxId, state } = req.body;
      const Settings = getSettings(req);
      let settings = await Settings.findOne();
      if (!settings) settings = new Settings({});
      if (address !== undefined) settings.address = address;
      if (phone !== undefined) settings.phone = phone;
      if (email !== undefined) settings.email = email;
      if (taxIdLabel !== undefined) settings.taxIdLabel = taxIdLabel;
      if (taxId !== undefined) settings.taxId = taxId;
      if (state !== undefined) settings.state = state;
      await settings.save();
      res.status(200).json({ success: true, message: "Business details updated successfully", data: settings });
    } catch (error) {
      console.error("Update Business Details Error:", error);
      res.status(500).json({ message: "Server Error" });
    }
  },

  updateBankDetails: async (req, res) => {
    try {
      const { accountName, accountNumber, bankName, ifscOrSwift, branch } = req.body;
      const Settings = getSettings(req);
      let settings = await Settings.findOne();
      if (!settings) settings = new Settings({});
      settings.bankDetails = {
        accountName: accountName ?? settings.bankDetails?.accountName ?? "",
        accountNumber: accountNumber ?? settings.bankDetails?.accountNumber ?? "",
        bankName: bankName ?? settings.bankDetails?.bankName ?? "",
        ifscOrSwift: ifscOrSwift ?? settings.bankDetails?.ifscOrSwift ?? "",
        branch: branch ?? settings.bankDetails?.branch ?? "",
      };
      await settings.save();
      res.status(200).json({ success: true, message: "Bank details updated successfully", data: settings });
    } catch (error) {
      console.error("Update Bank Details Error:", error);
      res.status(500).json({ message: "Server Error" });
    }
  },

  updateTerms: async (req, res) => {
    try {
      const { termsAndConditions } = req.body;
      if (termsAndConditions === undefined) return res.status(400).json({ message: "termsAndConditions is required" });
      const Settings = getSettings(req);
      let settings = await Settings.findOne();
      if (!settings) settings = new Settings({});
      settings.termsAndConditions = termsAndConditions;
      await settings.save();
      res.status(200).json({ success: true, message: "Terms & conditions updated successfully", data: settings });
    } catch (error) {
      console.error("Update Terms Error:", error);
      res.status(500).json({ message: "Server Error" });
    }
  },

  // Kicks off "Connect Gmail" for invoice sending — no password ever touches the CRM,
  // Google handles the login and just hands back a token via the OAuth callback below.
  getInvoiceGmailConnectUrl: async (req, res) => {
    try {
      const redirectUri = isLocalHost(req)
        ? process.env.GMAIL_REDIRECT_URI
        : process.env.GMAIL_LIVE_REDIRECT_URI;

      // The callback lands on a route with no user session (Google redirects the
      // browser directly), so tenant identity has to travel inside the state param.
      const state = Buffer.from(JSON.stringify({
        purpose: "invoice",
        dbName: req.tenant?.dbName || null,
        tenantSlug: req.tenant?.slug || null,
      })).toString("base64url");

      const url = generateAuthUrl(redirectUri, state);
      res.status(200).json({ success: true, url });
    } catch (error) {
      console.error("Get Invoice Gmail Connect URL Error:", error);
      res.status(500).json({ message: error.message || "Server Error" });
    }
  },

  disconnectInvoiceGmail: async (req, res) => {
    try {
      const Settings = getSettings(req);
      const settings = await Settings.findOne();
      if (settings) {
        settings.invoiceSenderEmail = null;
        await settings.save();
      }
      res.status(200).json({ success: true, message: "Invoice Gmail account disconnected" });
    } catch (error) {
      console.error("Disconnect Invoice Gmail Error:", error);
      res.status(500).json({ message: "Server Error" });
    }
  },

};
