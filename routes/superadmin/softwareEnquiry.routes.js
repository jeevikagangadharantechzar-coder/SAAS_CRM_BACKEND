import express from "express";
import { superAdminAuth } from "../../middlewares/superAdminAuth.js";
import {
  submitSoftwareEnquiry,
  validateSoftwareEnquiry,
  listSoftwareEnquiries,
  getSoftwareEnquiryDetails,
  updateSoftwareEnquiryStatus,
  deleteSoftwareEnquiry,
} from "../../controllers/softwareEnquiry.controller.js";

const router = express.Router();

// Public — anyone can submit a software enquiry from the marketing site
router.post("/submit", validateSoftwareEnquiry, submitSoftwareEnquiry);

// SuperAdmin-protected routes
router.get("/",             superAdminAuth, listSoftwareEnquiries);
router.get("/:id",          superAdminAuth, getSoftwareEnquiryDetails);
router.patch("/:id/status", superAdminAuth, updateSoftwareEnquiryStatus);
router.delete("/:id",       superAdminAuth, deleteSoftwareEnquiry);

export default router;
