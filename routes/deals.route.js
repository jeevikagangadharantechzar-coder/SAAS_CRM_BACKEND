import express from "express";
import indexControllers from "../controllers/index.controllers.js";
import {
  protect,
  adminOnly,
  adminOrAssignedToDeal,
} from "../middlewares/auth.middleware.js";
import upload from "../middlewares/upload.js";
import checkPlanFeature from "../middlewares/checkPlanFeature.js";

const router = express.Router();

// All routes are protected
router.use(protect);
// Pipeline view is just a different frontend lens on the same deals API, so
// either "deals_all" or "deals_pipeline" being enabled is enough to pass here.
router.use(checkPlanFeature(["deals_all", "deals_pipeline"]));

// Convert lead → deal
router.post(
  "/fromLead/:leadId",
  indexControllers.dealsController.createDealFromLead
);

// Get all deals
router.get(
  "/getAll",
  indexControllers.dealsController.getAllDeals
);

// Rejected deals — dedicated list + bulk delete + reject action (specific
// routes, must come before the generic "/:id" routes below)
router.get("/rejected", adminOnly, indexControllers.dealsController.getRejectedDeals);
router.post("/rejected/bulk-delete", adminOnly, indexControllers.dealsController.bulkDeleteRejectedDeals);
router.patch("/:id/reject", adminOnly, indexControllers.dealsController.rejectDeal);

// Get deal by ID
router.get(
  "/getAll/:id",
  adminOrAssignedToDeal,
  indexControllers.dealsController.getDealById
);

// Update deal stage
router.patch(
  "/:id/stage",
  adminOrAssignedToDeal,
  indexControllers.dealsController.updateStage
);

// Create manual deal
router.post(
  "/createManual",
  adminOnly,
  upload.array("attachments", 10),
  indexControllers.dealsController.createManualDeal
);

//schedule the deal
router.post(
  "/schedule-followup/:id",
  adminOrAssignedToDeal,
  indexControllers.dealsController.scheduleFollowUp
);


// Update deal
router.patch(
  "/update-deal/:id",
  adminOrAssignedToDeal,
  upload.array("attachments"),
  indexControllers.dealsController.updateDeal
);

// Complete follow-up
router.post(
  "/:id/complete-followup",
  adminOrAssignedToDeal,
  indexControllers.dealsController.completeFollowUp
);

// Delete deal
router.delete(
  "/delete-deal/:id",
  adminOrAssignedToDeal,
  indexControllers.dealsController.deleteDeal
);

// Bulk delete deals
router.delete(
  "/bulk-delete",
  protect,
  indexControllers.dealsController.bulkDeleteDeals
);

// Add this:
router.get(
  "/:id",
  adminOrAssignedToDeal,
  indexControllers.dealsController.getDealById
);
router.get("/pending", indexControllers.dealsController.pendingDeals);
router.get("/:id", adminOrAssignedToDeal, indexControllers.dealsController.getDealById);
export default router;
