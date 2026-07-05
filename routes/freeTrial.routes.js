import express from "express";
import { signupFreeTrial, validateFreeTrialSignup } from "../controllers/freeTrial.controller.js";

const router = express.Router();

// Public — anyone can sign up for a free trial from the landing page
router.post("/signup", validateFreeTrialSignup, signupFreeTrial);

export default router;
