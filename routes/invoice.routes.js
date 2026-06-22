import express from "express";
import indexController from "../controllers/index.controllers.js";
import { adminOnly, adminOrSales } from "../middlewares/auth.middleware.js";
import { protect } from "../middlewares/auth.middleware.js";

const router = express.Router();
//save the invoice
router.post(
  "/createinvoice",
  protect, //  this must come first to set req.user
  adminOrSales, //  now req.user is available here
  indexController.invoiceController.createInvoice
);

//  Add protect here so req.user is available
//get the invoice
router.get(
  "/getInvoice",
  protect,
  indexController.invoiceController.getAllInvoices
);
//get the single invoice by id
router.get(
  "/getSingle/:id",
  protect,
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
  protect, indexController.invoiceController.bulkDeleteInvoices
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
