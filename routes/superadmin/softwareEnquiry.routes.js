import express from "express";
import { superAdminAuth, requireSuperAdminPermission } from "../../middlewares/superAdminAuth.js";
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
router.get("/",             superAdminAuth, requireSuperAdminPermission("software_enquiries"), listSoftwareEnquiries);
router.get("/:id",          superAdminAuth, requireSuperAdminPermission("software_enquiries"), getSoftwareEnquiryDetails);
router.patch("/:id/status", superAdminAuth, requireSuperAdminPermission("software_enquiries"), updateSoftwareEnquiryStatus);
router.delete("/:id",       superAdminAuth, requireSuperAdminPermission("software_enquiries"), deleteSoftwareEnquiry);

export default router;
