import { getTenantModels } from "../models/tenant/index.js";
import EmailTemplateLegacy from "../models/emailTemplate.model.js";

const getModel = (req) =>
  req.tenantDB ? getTenantModels(req.tenantDB).EmailTemplate : EmailTemplateLegacy;

export default {
  getTemplates: async (req, res) => {
    try {
      const EmailTemplate = getModel(req);
      const templates = await EmailTemplate.find().sort({ createdAt: -1 });
      res.json({ success: true, templates });
    } catch (error) {
      console.error("Fetch templates error:", error);
      res.status(500).json({ message: "Failed to fetch templates" });
    }
  },

  createTemplate: async (req, res) => {
    try {
      const EmailTemplate = getModel(req);
      const { title, subject, content } = req.body;

      if (!title || !subject || !content) {
        return res.status(400).json({ message: "All fields are required" });
      }

      const template = await EmailTemplate.create({
        title,
        subject,
        content,
        createdBy: req.user._id,
      });

      res.status(201).json({ success: true, template });
    } catch (error) {
      console.error("Create template error:", error);
      res.status(500).json({ message: "Failed to create template" });
    }
  },
};
