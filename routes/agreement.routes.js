import express from "express";
import { protect } from "../middlewares/auth.middleware.js";
import agreementController from "../controllers/agreement.controller.js";

const router = express.Router();

router.use(protect);

// POST /agreements/accept — records acceptance of a Privacy Policy or Terms &
// Conditions document for the current user (see controllers/agreement.controller.js)
router.post("/accept", agreementController.acceptAgreement);

export default router;
