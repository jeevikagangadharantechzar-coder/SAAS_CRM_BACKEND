import express from "express";
import indexController from "../controllers/index.controllers.js";
import { adminOnly, adminOrSales, protect, requirePermission } from "../middlewares/auth.middleware.js";
import checkPlanFeature from "../middlewares/checkPlanFeature.js";

const router = express.Router();

router.use(checkPlanFeature("invoices"));
// Several routes below (delete/download/sendEmail/recent/pending/exchange-rate)
// previously had no protect at all — callable without even being logged in,
// not just without the "invoices" role permission. Router-level protect +
// requirePermission closes both gaps for every route in this file at once.
router.use(protect, requirePermission("invoices"));

//save the invoice
router.post(
  "/createinvoice",
  adminOrSales,
  indexController.invoiceController.createInvoice
);

//get the invoice
router.get(
  "/getInvoice",
  indexController.invoiceController.getAllInvoices
);
//get the single invoice by id
router.get(
  "/getSingle/:id",
  indexController.invoiceController.getInvoiceById
);
//update the invoice
router.put(
  "/updateInvoice/:id",
  indexController.invoiceController.updateInvoice
);
//delete the invoice by id
router.delete(
  "/delete/:id",
  indexController.invoiceController.deleteInvoice
);
//delete multiple invoice
router.delete(
  "/bulk-delete",
  indexController.invoiceController.bulkDeleteInvoices
);
//download the invoice
router.get(
  "/download/:id",
  indexController.invoiceController.generateInvoicePDF
);
//send the invoice throuth email
router.post(
  "/sendEmail/:id",
  indexController.invoiceController.sendInvoiceEmail
);
//recent invoice
router.get("/recent", indexController.invoiceController.getRecentInvoices);
//pending invoice
router.get("/pending", indexController.invoiceController.getPendingInvoices);
// conver other currency into INR value
router.get('/exchange-rate/:currency', async (req, res) => {
  try {
    const { currency } = req.params;
    const { getExchangeRate } = await import('../services/currencyService.js');
    const rate = await getExchangeRate(currency);
    res.json({ rate });
  } catch (error) {
    res.status(500).json({ rate: 1, error: error.message });
  }
});
export default router;
