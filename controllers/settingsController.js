import { getTenantModels } from "../models/tenant/index.js";
import SettingsLegacy from "../models/Settings.js";

const getSettings = (req) => req.tenantDB ? getTenantModels(req.tenantDB).Settings : SettingsLegacy;

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

};
