import express from "express";
import { protect } from "../middlewares/auth.middleware.js";
import {
  generateUserMfa,
  verifyAndEnableUserMfa,
  disableUserMfa
} from "../controllers/mfa.controller.js";

const router = express.Router();

router.post("/setup", protect, generateUserMfa);
router.post("/enable", protect, verifyAndEnableUserMfa);
router.post("/disable", protect, disableUserMfa);

export default router;
