import express from "express";
import { superAdminAuth } from "../../middlewares/superAdminAuth.js";
import {
  listTickets,
  getTicket,
  updateStatus,
  updatePriority,
  addPlatformMessage,
} from "../../controllers/supportTicket.controller.js";

const router = express.Router();

router.use(superAdminAuth);

router.get("/", listTickets);
router.get("/:id", getTicket);
router.patch("/:id/status", updateStatus);
router.patch("/:id/priority", updatePriority);
router.post("/:id/messages", addPlatformMessage);

export default router;
