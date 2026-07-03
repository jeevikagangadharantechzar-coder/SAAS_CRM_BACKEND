import express from "express";
import { protect, adminCreateOnly } from "../middlewares/auth.middleware.js";
import settingsController from "../controllers/settingsController.js";
import uploadCompanyLogo from "../middlewares/uploadCompanyLogo.js";
import indexControllers from "../controllers/index.controllers.js";

const router = express.Router();

/**
 * GET company settings
 */
router.get("/", indexControllers.settingsController. getSettings);

/**
 * UPDATE company logo
 */
router.post(
  "/logo",
  protect,                // Must be logged in
  adminCreateOnly,        // Must be Admin
  uploadCompanyLogo.single("logo"),indexControllers.settingsController.
  updateLogo
);

/**
 * UPDATE favicon
 */
router.post(
  "/favicon",
  protect,
  adminCreateOnly,
  uploadCompanyLogo.single("favicon"),indexControllers.settingsController.
  updateFavicon
);

/**
 * UPDATE company name (browser title)
 */
router.put(
  "/company-name",
  protect,
  adminCreateOnly,indexControllers.settingsController.
  updateCompanyName
);

/**
 * UPDATE invoice logo
 */
router.post(
  "/invoice-logo",
  protect,
  adminCreateOnly,
  uploadCompanyLogo.single("logo"),indexControllers.settingsController.
  updateInvoiceLogo
);

/**
 * UPDATE business details (address/phone/email/tax ID) shown on invoices
 */
router.put(
  "/business-details",
  protect,
  adminCreateOnly,
  indexControllers.settingsController.updateBusinessDetails
);

/**
 * UPDATE bank details shown on invoices
 */
router.put(
  "/bank-details",
  protect,
  adminCreateOnly,
  indexControllers.settingsController.updateBankDetails
);

/**
 * UPDATE invoice terms & conditions
 */
router.put(
  "/terms",
  protect,
  adminCreateOnly,
  indexControllers.settingsController.updateTerms
);

/**
 * GET the "Connect Gmail" URL for invoice sending (OAuth — no password)
 */
router.get(
  "/invoice-email/connect-url",
  protect,
  adminCreateOnly,
  indexControllers.settingsController.getInvoiceGmailConnectUrl
);

/**
 * DISCONNECT the Gmail account used for sending invoices
 */
router.delete(
  "/invoice-email",
  protect,
  adminCreateOnly,
  indexControllers.settingsController.disconnectInvoiceGmail
);

export default router;