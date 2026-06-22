import mongoose from "mongoose";
import path from "path";
import ejs from "ejs";
import fs from "fs";
import puppeteer from "puppeteer";
import nodemailer from "nodemailer";
import { getExchangeRate } from "../services/currencyService.js";
import { getTenantModels } from "../models/tenant/index.js";
import InvoiceLegacy from "../models/invoice.model.js";
import SettingsLegacy from "../models/Settings.js";

const getInvoice = (req) => req.tenantDB ? getTenantModels(req.tenantDB).Invoice : InvoiceLegacy;

let browserInstance = null;
const getBrowser = async () => {
  if (!browserInstance) {
    browserInstance = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox","--disable-setuid-sandbox","--disable-gpu","--disable-dev-shm-usage"],
    });
  }
  return browserInstance;
};

export default {
  createInvoice: async (req, res) => {
    try {
      if (!req.user?.role || req.user.role.name?.toLowerCase() !== "admin")
        return res.status(403).json({ error: "Only Admin can create invoices" });

      const Invoice = getInvoice(req);
      let { items, tax = 0, taxType = "percentage", discountValue = 0, discountType = "percentage", currency = "USD", assignTo, dueDate, ...rest } = req.body;
      if (!items || items.length === 0) return res.status(400).json({ error: "Invoice must contain at least one item" });

      tax = Number(tax) || 0; discountValue = Number(discountValue) || 0;
      const subtotal = items.reduce((acc, item) => acc + (Number(item.quantity)||0) * (Number(item.unitPrice)||0), 0);
      const taxAmount = taxType === "percentage" ? (subtotal * tax) / 100 : tax;
      const discount  = discountType === "percentage" ? (subtotal * discountValue) / 100 : discountValue;
      let total = subtotal + taxAmount - discount;
      if (total < 0) total = 0;

      const newInvoice = new Invoice({ items, subtotal, tax, taxType, taxAmount, discountValue, discountType, discount, total, currency, assignTo, dueDate, createdBy: req.user._id, ...rest });
      await newInvoice.save();
      res.status(201).json({ message: "Invoice created successfully", invoice: newInvoice });
    } catch (error) {
      console.error("Error creating invoice:", error);
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  },

  getInvoiceById: async (req, res) => {
    try {
      const Invoice = getInvoice(req);
      const invoice = await Invoice.findById(req.params.id)
        .populate("assignTo", "firstName lastName email")
        .populate("items.deal", "dealName value stage companyName");
      if (!invoice) return res.status(404).json({ message: "Invoice not found" });
      res.status(200).json(invoice);
    } catch (error) { res.status(500).json({ error: error.message }); }
  },

  getAllInvoices: async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Unauthorized: No user found" });
      const Invoice = getInvoice(req);
      const roleName = req.user.role?.name?.toLowerCase();
      let query;
      if (roleName === "admin")       query = Invoice.find();
      else if (roleName === "sales")  query = Invoice.find({ assignTo: req.user._id });
      else return res.status(403).json({ error: "Access denied" });

      const invoices = await query
        .populate("assignTo", "firstName lastName email")
        .populate("items.deal", "dealName value stage")
        .sort({ createdAt: -1 });
      res.status(200).json(invoices);
    } catch (error) {
      console.error("Error fetching invoices:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  updateInvoice: async (req, res) => {
    try {
      const Invoice = getInvoice(req);
      const invoice = await Invoice.findById(req.params.id);
      if (!invoice) return res.status(404).json({ message: "Invoice not found" });

      let { items, tax = 0, discount = 0, discountType = "fixed", discountValue = 0, taxType = "fixed", price, status, ...rest } = req.body;
      let subtotal = 0, finalDiscount = 0, taxAmount = 0, finalTotal = 0;

      if (items && items.length > 0) {
        items = items.map(item => { const a = (Number(item.price)||0) * (Number(item.quantity)||1); return { ...item, amount: a.toFixed(2) }; });
        subtotal = items.reduce((s, i) => s + Number(i.amount), 0);
      } else if (price) {
        subtotal = Number(price) || 0;
        items = [{ deal: rest.deal || invoice.items?.[0]?.deal, price: subtotal, amount: subtotal, quantity: 1 }];
      } else {
        subtotal = invoice.subtotal || 0;
      }

      finalDiscount = discountType === "percentage" ? (subtotal * discountValue) / 100 : (Number(discountValue) || Number(discount) || 0);
      if (finalDiscount > subtotal) finalDiscount = subtotal;
      const discountedSubtotal = subtotal - finalDiscount;
      taxAmount = taxType === "percentage" ? (discountedSubtotal * tax) / 100 : (Number(tax) || 0);
      finalTotal = Math.max(discountedSubtotal + taxAmount, 0);

      const updateData = {
        ...rest, items,
        subtotal: Number(subtotal.toFixed(2)), discount: Number(finalDiscount.toFixed(2)),
        discountValue: Number(discountValue) || Number(discount) || 0, discountType: discountType || "fixed",
        tax: Number(tax) || 0, taxType: taxType || "fixed", taxAmount: Number(taxAmount.toFixed(2)),
        total: Number(finalTotal.toFixed(2)),
      };

      const currentStatus = invoice.status;
      const newStatus = status || currentStatus;
      if (newStatus === "paid" && currentStatus !== "paid") {
        const exchangeRate = await getExchangeRate(invoice.currency);
        updateData.paidAt = new Date(); updateData.inrAmount = finalTotal * exchangeRate;
        updateData.exchangeRate = exchangeRate; updateData.status = "paid";
      } else {
        updateData.status = newStatus;
      }

      const updated = await Invoice.findByIdAndUpdate(req.params.id, updateData, { new: true, runValidators: true })
        .populate("assignTo", "firstName lastName email role")
        .populate("items.deal", "dealName value stage");
      res.status(200).json(updated);
    } catch (error) {
      console.error("Error updating invoice:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  deleteInvoice: async (req, res) => {
    try {
      const Invoice = getInvoice(req);
      const deleted = await Invoice.findByIdAndDelete(req.params.id);
      if (!deleted) return res.status(404).json({ message: "Invoice not found" });
      res.status(200).json({ message: "Invoice deleted successfully" });
    } catch (error) { res.status(500).json({ error: error.message }); }
  },

  bulkDeleteInvoices: async (req, res) => {
    try {
      const { ids } = req.body;
      if (!ids || !Array.isArray(ids) || ids.length === 0)
        return res.status(400).json({ success: false, message: "Please provide an array of invoice IDs to delete" });
      const Invoice = getInvoice(req);
      const roleName = req.user.role?.name?.toLowerCase();
      let query = { _id: { $in: ids } };
      if (roleName !== "admin") query.assignTo = req.user._id;
      const toDelete = await Invoice.find(query);
      if (toDelete.length === 0) return res.status(404).json({ success: false, message: "No invoices found to delete" });
      const result = await Invoice.deleteMany(query);
      res.status(200).json({ success: true, message: `${result.deletedCount} invoice(s) deleted successfully`, deletedCount: result.deletedCount });
    } catch (error) {
      console.error("Bulk delete invoices error:", error);
      res.status(500).json({ success: false, message: "Failed to delete invoices", error: error.message });
    }
  },

  generateInvoicePDF: async (req, res) => {
    try {
      const invoiceId = req.params.id;
      if (!mongoose.Types.ObjectId.isValid(invoiceId)) return res.status(400).json({ error: "Invalid invoice ID" });
      const Invoice = getInvoice(req);
      const invoice = await Invoice.findById(invoiceId)
        .populate("assignTo", "firstName lastName email")
        .populate("items.deal", "dealName value stage email companyName address country phoneNumber");
      if (!invoice) return res.status(404).json({ error: "Invoice not found" });

      const Settings = req.tenantDB ? getTenantModels(req.tenantDB).Settings : SettingsLegacy;
      const settings = await Settings.findOne();
      
      let logoDataURI = "";
      if (settings) {
        const logoRelativePath = settings.invoiceLogo || settings.logo;
        if (logoRelativePath) {
          const logoPath = path.join(process.cwd(), logoRelativePath);
          if (fs.existsSync(logoPath)) {
            const ext = path.extname(logoPath).substring(1);
            const base64 = fs.readFileSync(logoPath, { encoding: 'base64' });
            logoDataURI = `data:image/${ext};base64,${base64}`;
          }
        }
      }

      const templatePath = path.join(process.cwd(), "views", "invoiceTemplate.ejs");
      if (!fs.existsSync(templatePath)) return res.status(500).json({ error: "Template file not found" });

      const templateData = await ejs.renderFile(templatePath, { invoice, logoDataURI }, { async: true });
      const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox","--disable-setuid-sandbox","--disable-gpu","--disable-dev-shm-usage"] });
      const page = await browser.newPage();
      await page.setContent(templateData, { waitUntil: "networkidle0" });
      const pdfBuffer = await page.pdf({ format: "A4", margin: { top:"20mm", right:"10mm", bottom:"20mm", left:"10mm" }, printBackground: true });
      await browser.close();

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename=Invoice_${invoice.invoicenumber || invoice._id}.pdf`);
      res.setHeader("Content-Length", pdfBuffer.length);
      return res.end(pdfBuffer);
    } catch (error) {
      console.error("Error generating PDF:", error);
      res.status(500).json({ error: "Failed to generate PDF", details: error.message });
    }
  },

  sendInvoiceEmail: async (req, res) => {
    try {
      const { id } = req.params;
      const { fromEmail, toEmail } = req.body;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid invoice ID" });
      const Invoice = getInvoice(req);
      const invoice = await Invoice.findById(id).populate("items.deal", "dealName email value stage");
      if (!invoice) return res.status(404).json({ error: "Invoice not found" });

      const clientEmails = invoice.items.map(i => i.deal?.email).filter(Boolean);
      const targetEmails = toEmail ? [toEmail] : clientEmails;
      if (targetEmails.length === 0) return res.status(400).json({ error: "No client emails found in invoice deals" });

      res.status(200).json({ message: "Invoice email is being sent!" });
      setImmediate(async () => {
        try {
          const Settings = req.tenantDB ? getTenantModels(req.tenantDB).Settings : SettingsLegacy;
          const settings = await Settings.findOne();
          
          let logoDataURI = "";
          if (settings) {
            const logoRelativePath = settings.invoiceLogo || settings.logo;
            if (logoRelativePath) {
              const logoPath = path.join(process.cwd(), logoRelativePath);
              if (fs.existsSync(logoPath)) {
                const ext = path.extname(logoPath).substring(1);
                const base64 = fs.readFileSync(logoPath, { encoding: 'base64' });
                logoDataURI = `data:image/${ext};base64,${base64}`;
              }
            }
          }

          const templatePath = path.join(process.cwd(), "views", "invoiceTemplate.ejs");
          if (!fs.existsSync(templatePath)) return;
          const templateData = await ejs.renderFile(templatePath, { invoice, logoDataURI }, { async: true });
          const browser = await getBrowser();
          const page = await browser.newPage();
          await page.setContent(templateData, { waitUntil: "networkidle0" });
          const pdfBuffer = await page.pdf({ format: "A4", margin: { top:"20mm", right:"10mm", bottom:"20mm", left:"10mm" }, printBackground: true });
          await page.close();

          const transporter = nodemailer.createTransport({ service: "gmail", auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
          
          const finalFromEmail = fromEmail || req.tenant?.adminEmail || process.env.EMAIL_USER;
          const fromName = settings?.companyName || req.tenant?.name || "CRM Software";

          for (const email of targetEmails) {
            await transporter.sendMail({
              from: `"${fromName}" <${finalFromEmail}>`,
              to: email,
              subject: `Invoice #${invoice.invoicenumber || invoice._id}`,
              text: `Hello,\n\nPlease find attached your invoice #${invoice.invoicenumber || invoice._id}.\n\nIncluded deals:\n${invoice.items.map(i => `- ${i.deal.dealName}`).join("\n")}\n\nThank you!`,
              attachments: [{ filename: `Invoice_${invoice.invoicenumber || invoice._id}.pdf`, content: pdfBuffer }],
            });
          }
        } catch (err) { console.error("Error sending invoice email asynchronously:", err); }
      });
    } catch (error) {
      console.error("Error processing invoice email request:", error);
      res.status(500).json({ error: "Failed to send invoice email", details: error.message });
    }
  },

  getRecentInvoices: async (req, res) => {
    try {
      const Invoice = getInvoice(req);
      const now = new Date(); const oneMonthAgo = new Date(); oneMonthAgo.setMonth(now.getMonth() - 1);
      const invoices = await Invoice.find({ createdAt: { $gte: oneMonthAgo, $lte: now } })
        .sort({ createdAt: -1 }).populate("assignTo", "firstName lastName email");
      res.status(200).json(invoices);
    } catch (err) { res.status(500).json({ error: err.message }); }
  },

  getPendingInvoices: async (req, res) => {
    try {
      const Invoice = getInvoice(req);
      const invoices = await Invoice.find({ status: { $in: ["unpaid"] } })
        .sort({ createdAt: -1 }).limit(5).populate("assignTo", "firstName lastName email");
      res.status(200).json(invoices);
    } catch (err) { res.status(500).json({ error: err.message }); }
  },
};
