import express from "express";
import indexControllers from "../controllers/index.controllers.js";
import upload, { normalizePaths } from "../middlewares/upload.js";
import { protect } from "../middlewares/auth.middleware.js";
import checkPlanFeature from "../middlewares/checkPlanFeature.js";

const router = express.Router();

router.use(checkPlanFeature("proposal"));


// POST send proposal email
router.post(
  "/mailsend",
  protect, 
  upload.array("attachments", 10),
  normalizePaths,
  indexControllers.proposalController.sendProposal
);
// GET all proposals
router.get("/getall", protect, indexControllers.proposalController.getAllProposals);
// GET draft proposals
router.get("/drafts", protect, indexControllers.proposalController.getDraftProposals);
// PUT update proposal status
router.put("/updatestatus/:id", protect, indexControllers.proposalController.updateStatus);
// Put update proposal
router.put("/update/:id", protect, indexControllers.proposalController.updateProposal); 
// Delete propslal
router.delete("/delete/:id", protect, indexControllers.proposalController.deleteProposal); 
//delete multiple proposal
router.delete("/bulk-delete", protect, indexControllers.proposalController.bulkDeleteProposals); 
//create follow up for proposal
router.put("/followup/:id", protect, indexControllers.proposalController.updateFollowUp); 


router.get("/:id", protect, indexControllers.proposalController.getProposal); 

export default router;