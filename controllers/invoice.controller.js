import mongoose from "mongoose";
import path from "path";
import ejs from "ejs";
import fs from "fs";
import puppeteer from "puppeteer";
import nodemailer from "nodemailer";
import axios from "axios";
import { getExchangeRate } from "../services/currencyService.js";
import { getTenantModels } from "../models/tenant/index.js";
import { notifyUser } from "../realtime/socket.js";
import InvoiceLegacy from "../models/invoice.model.js";
import SettingsLegacy from "../models/Settings.js";
import { sendEmailWithAttachments } from "../utils/gmailService.js";
import { sendNotification, sendNotificationToAdmins } from "../services/notificationService.js";

const getInvoice = (req) => req.tenantDB ? getTenantModels(req.tenantDB).Invoice : InvoiceLegacy;

// Statuses where an invoice is considered (at least partly) paid and tracks amountPaid
const PAID_FAMILY = ["paid", "partially_paid"];

let browserInstance = null;
const getBrowser = async () => {
  if (!browserInstance || !browserInstance.isConnected()) {
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
      let {
        items, tax = 0, taxType = "percentage", discountValue = 0, discountType = "percentage",
        currency = "USD", assignTo, dueDate, status = "unpaid", paymentReceivedNow,
        preferredCurrency, preferredCurrencyValue, ...rest
      } = req.body;
      if (!items || items.length === 0) return res.status(400).json({ error: "Invoice must contain at least one item" });

      tax = Number(tax) || 0; discountValue = Number(discountValue) || 0;
      const subtotal = items.reduce((acc, item) => acc + (Number(item.price)||0) * (Number(item.quantity)||1), 0);
      // Discount is applied first (on the raw subtotal), then tax is computed on what's left —
      // matches the frontend invoice form and updateInvoice below.
      const discount  = discountType === "percentage" ? (subtotal * discountValue) / 100 : discountValue;
      const discountedSubtotal = subtotal - discount;
      const taxAmount = taxType === "percentage" ? (discountedSubtotal * tax) / 100 : tax;
      let total = discountedSubtotal + taxAmount;
      if (total < 0) total = 0;

      const invoiceFields = { items, subtotal, tax, taxType, taxAmount, discountValue, discountType, discount, total, currency, assignTo, dueDate, status, createdBy: req.user._id, ...rest };

      if (PAID_FAMILY.includes(status)) {
        const payment = Math.min(Math.max(Number(paymentReceivedNow) || 0, 0), total);
        invoiceFields.amountPaid = Number(payment.toFixed(2));
        if (preferredCurrency) invoiceFields.preferredCurrency = preferredCurrency;
        if (preferredCurrencyValue != null) invoiceFields.preferredCurrencyValue = parseFloat(preferredCurrencyValue);

        if (status === "paid") {
          const exchangeRate = await getExchangeRate(currency);
          invoiceFields.paidAt       = new Date();
          invoiceFields.exchangeRate = exchangeRate;
          invoiceFields.inrAmount    = invoiceFields.amountPaid * exchangeRate;
        }
      }

      invoiceFields.statusHistory = [
        { status, amountPaid: invoiceFields.amountPaid || 0, changedAt: new Date(), changedBy: req.user._id },
      ];

      const newInvoice = new Invoice(invoiceFields);
      await newInvoice.save();
      res.status(201).json({ message: "Invoice created successfully", invoice: newInvoice });
      notifyUser(String(req.user._id), "invoice_updated", { invoiceId: String(newInvoice._id), action: "created" });

      try {
        if (assignTo) {
          await sendNotification(assignTo, `Invoice #${newInvoice.invoicenumber} created and assigned to you`, "invoice",
            { invoiceId: String(newInvoice._id), event: "created" }, { title: "Invoice Assigned" }, req.tenantDB);
        }
        await sendNotificationToAdmins(`Invoice #${newInvoice.invoicenumber} was created`, "invoice",
          { invoiceId: String(newInvoice._id), event: "created" }, { title: "Invoice Created" },
          [req.user._id], req.tenantDB);
      } catch (notifyErr) {
        console.error("invoice created notification error:", notifyErr);
      }
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
        .populate("items.deal", "dealName value stage companyName email address country phoneNumber");
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

      let { items, tax = 0, discount = 0, discountType = "fixed", discountValue = 0, taxType = "fixed", price, status, paymentReceivedNow, ...rest } = req.body;
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
        lastUpdatedBy: req.user._id,
      };

      const currentStatus = invoice.status;
      const newStatus = status || currentStatus;

      if (PAID_FAMILY.includes(newStatus)) {
        // Cumulative amount collected so far carries over between paid/partially_paid.
        // Switching in from unpaid starts the count fresh.
        const previousAmountPaid = PAID_FAMILY.includes(currentStatus)
          ? Number(invoice.amountPaid) || 0
          : 0;
        const payment = Number(paymentReceivedNow) || 0;
        const maxAllowed = Math.max(finalTotal - previousAmountPaid, 0);

        if (payment > maxAllowed) {
          return res.status(400).json({
            error: `Payment exceeds invoice total. Maximum you can add now: ${maxAllowed.toFixed(2)}`,
          });
        }

        const newAmountPaid = Number((previousAmountPaid + payment).toFixed(2));
        updateData.status     = newStatus;
        updateData.amountPaid = newAmountPaid;

        // Frontend sends preferredCurrency/preferredCurrencyValue computed for the cumulative amount paid
        const { preferredCurrency, preferredCurrencyValue } = req.body;
        if (preferredCurrency) updateData.preferredCurrency = preferredCurrency;
        if (preferredCurrencyValue != null) updateData.preferredCurrencyValue = parseFloat(preferredCurrencyValue);

        if (newStatus === "paid" && currentStatus !== "paid") {
          const exchangeRate = await getExchangeRate(invoice.currency);
          updateData.paidAt       = new Date();
          updateData.inrAmount    = newAmountPaid * exchangeRate;
          updateData.exchangeRate = exchangeRate;
        }
      } else {
        updateData.status = newStatus;
        // Reset payment tracking + frozen currency when moving away from paid/partially_paid
        if (PAID_FAMILY.includes(currentStatus)) {
          updateData.amountPaid             = 0;
          updateData.preferredCurrency      = null;
          updateData.preferredCurrencyValue = null;
          updateData.paidAt                 = null;
          updateData.inrAmount              = null;
          updateData.exchangeRate           = null;
        }
      }

      // Log a transition whenever the status itself changed, or — since
      // partially_paid can be hit multiple times as more payments come in —
      // whenever the amount collected changed even with the status held the
      // same, so the payment journey isn't lost between two partial payments.
      const amountChanged = updateData.amountPaid !== undefined && updateData.amountPaid !== (Number(invoice.amountPaid) || 0);
      if (newStatus !== currentStatus || amountChanged) {
        updateData.$push = {
          statusHistory: {
            status: newStatus,
            amountPaid: updateData.amountPaid ?? invoice.amountPaid ?? 0,
            changedAt: new Date(),
            changedBy: req.user._id,
          },
        };
      }

      const updated = await Invoice.findByIdAndUpdate(req.params.id, updateData, { new: true, runValidators: true })
        .populate("assignTo", "firstName lastName email role")
        .populate("items.deal", "dealName value stage");
      res.status(200).json(updated);
      try {
        notifyUser(String(req.user._id), "invoice_updated", { invoiceId: String(updated._id), action: "updated", status: updateData.status });
      } catch (notifyErr) {
        console.error("invoice_updated notify error:", notifyErr);
      }

      if (newStatus !== currentStatus) {
        try {
          const statusLabel = newStatus === "paid" ? "paid" : newStatus === "partially_paid" ? "partially paid" : "unpaid";
          const message = `Invoice #${updated.invoicenumber} marked as ${statusLabel}`;
          const meta = { invoiceId: String(updated._id), event: "status_change", status: newStatus };
          const assignedToId = updated.assignTo?._id;
          if (assignedToId) {
            await sendNotification(assignedToId, message, "invoice", meta, { title: "Invoice Payment Update" }, req.tenantDB);
          }
          await sendNotificationToAdmins(message, "invoice", meta, { title: "Invoice Payment Update" },
            assignedToId ? [assignedToId] : [], req.tenantDB);
        } catch (notifyErr) {
          console.error("invoice status change notification error:", notifyErr);
        }
      }
    } catch (error) {
      console.error("Error updating invoice:", error);
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
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

      const templateData = await ejs.renderFile(templatePath, { invoice, logoDataURI, settings }, { async: true });
      const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox","--disable-setuid-sandbox","--disable-gpu","--disable-dev-shm-usage"] });
      const page = await browser.newPage();
      await page.setContent(templateData, { waitUntil: "networkidle0" });
      // Puppeteer's page.pdf() returns a plain Uint8Array, not a Node Buffer —
      // Buffer.from(...) is required here so downstream .toString("base64")
      // actually base64-encodes the bytes instead of silently ignoring the
      // encoding argument and stringifying as comma-separated decimal values.
      const pdfBuffer = Buffer.from(await page.pdf({ format: "A4", margin: { top:"20mm", right:"10mm", bottom:"20mm", left:"10mm" }, printBackground: true }));
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
      const invoice = await Invoice.findById(id).populate("items.deal", "dealName email value stage companyName address country phoneNumber");
      if (!invoice) return res.status(404).json({ error: "Invoice not found" });

      const clientEmails = invoice.items.map(i => i.deal?.email).filter(Boolean);
      const targetEmails = toEmail ? [toEmail] : clientEmails;
      if (targetEmails.length === 0) return res.status(400).json({ error: "No client emails found in invoice deals" });

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
      if (!fs.existsSync(templatePath)) return res.status(500).json({ error: "Invoice template not found" });
      const templateData = await ejs.renderFile(templatePath, { invoice, logoDataURI, settings }, { async: true });
      const browser = await getBrowser();
      const page = await browser.newPage();
      await page.setContent(templateData, { waitUntil: "networkidle0" });
      // See note in generateInvoicePDF above — Buffer.from(...) is required because
      // page.pdf() returns a Uint8Array, and Uint8Array#toString ignores the
      // "base64" argument entirely.
      const pdfBuffer = Buffer.from(await page.pdf({ format: "A4", margin: { top:"20mm", right:"10mm", bottom:"20mm", left:"10mm" }, printBackground: true }));
      await page.close();

      const subject = `Invoice #${invoice.invoicenumber || invoice._id}`;
      const message = `Hello,\n\nPlease find attached your invoice #${invoice.invoicenumber || invoice._id}.\n\nIncluded deals:\n${invoice.items.map(i => `- ${i.deal.dealName}`).join("\n")}\n\nThank you!`;
      const attachmentFilename = `Invoice_${invoice.invoicenumber || invoice._id}.pdf`;

      if (settings?.invoiceSenderEmail) {
        // Tenant connected their own Gmail via OAuth — send genuinely as that account
        // through the Gmail API, no SMTP credentials involved at all.
        const attachment = {
          filename: attachmentFilename,
          content: pdfBuffer.toString("base64"),
          mimetype: "application/pdf",
          size: pdfBuffer.length,
        };
        for (const email of targetEmails) {
          await sendEmailWithAttachments(email, subject, message, "", "", [attachment], [], settings.invoiceSenderEmail);
        }
      } else {
        // No tenant Gmail connected — fall back to the shared platform mailbox
        const transporter = nodemailer.createTransport({
          service: "gmail",
          auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
        });

        const finalFromEmail = fromEmail || req.tenant?.adminEmail || process.env.EMAIL_USER;
        const fromName = settings?.companyName || req.tenant?.name || "CRM Software";

        for (const email of targetEmails) {
          await transporter.sendMail({
            from: `"${fromName}" <${finalFromEmail}>`,
            to: email,
            subject,
            text: message,
            attachments: [{ filename: attachmentFilename, content: pdfBuffer }],
          });
        }
      }

      invoice.emailSentAt = new Date();
      await invoice.save();

      res.status(200).json({ message: "Invoice email sent successfully!" });
    } catch (error) {
      console.error("Error sending invoice email:", error);
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
