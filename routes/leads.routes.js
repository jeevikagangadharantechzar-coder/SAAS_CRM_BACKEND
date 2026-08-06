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
router.get("/trash", adminOnly, indexControllers.leadsController.getTrashLeads);
router.post("/trash/bulk-restore", adminOnly, indexControllers.leadsController.bulkRestoreLeads);
router.post("/trash/bulk-delete", adminOnly, indexControllers.leadsController.bulkDeleteTrashLeads);

//  IMPORT / EXPORT ROUTES
router.get("/export", indexControllers.leadsController.exportLeads);
router.post("/bulk-import", adminOrSales, indexControllers.leadsController.bulkImportLeads);

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
router.patch("/:id/trash", adminOnly, indexControllers.leadsController.trashLead);
router.patch("/:id/restore", adminOnly, indexControllers.leadsController.restoreLead);
router.patch("/:id/followup", protect, indexControllers.leadsController.updateFollowUpDate);
router.post("/:id/followup-notes", adminOrAssigned, upload.single("audio"), indexControllers.leadsController.addFollowUpNote);
router.patch("/:id/followup-notes/:noteId", adminOrAssigned, upload.single("audio"), indexControllers.leadsController.editFollowUpNote);
router.delete("/:id/followup-notes/:noteId", adminOrAssigned, indexControllers.leadsController.deleteFollowUpNote);
router.get("/:id/activity", adminOrAssigned, indexControllers.leadsController.getLeadActivityLog);
router.get("/:id/meetings", adminOrAssigned, indexControllers.leadsController.getLeadMeetings);
router.get("/:id/emails", adminOrAssigned, indexControllers.leadsController.getLeadEmails);

//  GENERIC ROUTE WITH :id LAST (catch-all for /:id)
router.get("/getLead/:id", adminOrAssigned, indexControllers.leadsController.getLeadById);

export default router;