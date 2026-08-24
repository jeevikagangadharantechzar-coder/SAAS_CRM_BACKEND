import express from "express";
import indexControllers from "../controllers/index.controllers.js";
import upload, { normalizePaths } from "../middlewares/upload.js";
import { protect, requirePermission } from "../middlewares/auth.middleware.js";
import checkPlanFeature from "../middlewares/checkPlanFeature.js";

const router = express.Router();

router.use(checkPlanFeature("proposal"));
router.use(protect, requirePermission("proposal"));


// POST send proposal email
router.post(
  "/mailsend",
  upload.array("attachments", 10),
  normalizePaths,
  indexControllers.proposalController.sendProposal
);
// GET all proposals
router.get("/getall", indexControllers.proposalController.getAllProposals);
// GET draft proposals
router.get("/drafts", indexControllers.proposalController.getDraftProposals);
// PUT update proposal status
router.put("/updatestatus/:id", indexControllers.proposalController.updateStatus);
// Put update proposal
router.put("/update/:id", indexControllers.proposalController.updateProposal);
// Delete propslal
router.delete("/delete/:id", indexControllers.proposalController.deleteProposal);
//delete multiple proposal
router.delete("/bulk-delete", indexControllers.proposalController.bulkDeleteProposals);
//create follow up for proposal
router.put("/followup/:id", indexControllers.proposalController.updateFollowUp);


router.get("/:id", indexControllers.proposalController.getProposal);

export default router;