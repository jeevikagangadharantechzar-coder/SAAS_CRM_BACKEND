import express from "express";
import documentHubController from "../controllers/documentHub.controller.js";
import { protect } from "../middlewares/auth.middleware.js";
import upload from "../middlewares/upload.js";

const router = express.Router();

router.use(protect);

router.get("/documents", documentHubController.getAllDocuments);
router.get("/recycle-bin", documentHubController.getRecycleBin);

router.post("/documents/assign", documentHubController.assignDocuments);
router.get("/documents/secure-serve", documentHubController.serveSecureFile);

// Generic document mutation routes (handles Lead, Deal, External based on sourceType/sourceId)
router.patch("/documents/:id/status", documentHubController.updateDocumentStatus);
router.patch("/documents/:id/mark-viewed", documentHubController.markViewed);
router.post("/documents/:id/activity", documentHubController.addActivity);
router.delete("/documents/:id", documentHubController.softDeleteDocument);
router.delete("/documents/source/:sourceDocId", documentHubController.softDeleteSourceDocument);
router.post("/documents/:id/restore", documentHubController.restoreDocument);
router.delete("/documents/:id/permanent", documentHubController.permanentDeleteDocument);

// External Document Upload (uses 'document' as the multer field name)
router.post("/external", upload.single("document"), documentHubController.uploadExternalDocument);

export default router;
