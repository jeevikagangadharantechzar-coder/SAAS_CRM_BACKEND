import express from "express";
import indexControllers from "../controllers/index.controllers.js";
import { protect, adminOrAssigned, adminOnly, adminOrSales } from "../middlewares/auth.middleware.js";
import upload from "../middlewares/upload.js";
import checkPlanFeature from "../middlewares/checkPlanFeature.js";

const router = express.Router();

// Apply protect middleware to all routes
router.use(protect);
router.use(checkPlanFeature("leads"));

//  SPECIFIC ROUTES FIRST (no :id parameters)
router.get("/getAllLead", indexControllers.leadsController.getLeads);
router.get("/recent", indexControllers.leadsController.getRecentLeads);
router.get("/pending", indexControllers.leadsController.getPendingLeads);
router.get("/missed-followups", indexControllers.leadsController.getMissedFollowUps);
router.get("/rejected", adminOnly, indexControllers.leadsController.getRejectedLeads);
router.post("/rejected/bulk-delete", adminOnly, indexControllers.leadsController.bulkDeleteRejectedLeads);

//  CREATE ROUTE
router.post(
  "/create",
  adminOrSales,
  upload.array("attachments", 5),
  indexControllers.leadsController.createLead
);

//  UPDATE/DELETE ROUTES (with :id but still specific paths)
router.put("/updateLead/:id", upload.array("attachments", 5), adminOrAssigned, indexControllers.leadsController.updateLead);
router.delete("/deleteLead/:id", adminOrAssigned, indexControllers.leadsController.deleteLead);

//  ACTION ROUTES (these have :id but are still specific action paths)(convert, show status, create follow-up)
router.patch("/:id/convert", adminOrAssigned, indexControllers.leadsController.convertLeadToDeal);
router.patch("/:id/status", adminOrAssigned, indexControllers.leadsController.updateLeadStatus);
router.patch("/:id/reject", adminOnly, indexControllers.leadsController.rejectLead);
router.patch("/:id/followup", protect, indexControllers.leadsController.updateFollowUpDate);
router.post("/:id/followup-notes", adminOrAssigned, indexControllers.leadsController.addFollowUpNote);

//  GENERIC ROUTE WITH :id LAST (catch-all for /:id)
router.get("/getLead/:id", adminOrAssigned, indexControllers.leadsController.getLeadById);

export default router;