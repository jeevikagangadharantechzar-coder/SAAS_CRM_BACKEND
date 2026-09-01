import express from "express";
import { superAdminAuth, requireSuperAdminPermission } from "../../middlewares/superAdminAuth.js";
import {
  listTickets,
  getTicket,
  updateStatus,
  updatePriority,
  updateResolutionDate,
  addPlatformMessage,
} from "../../controllers/supportTicket.controller.js";

const router = express.Router();

router.use(superAdminAuth, requireSuperAdminPermission("support_tickets"));

router.get("/", listTickets);
router.get("/:id", getTicket);
router.patch("/:id/status", updateStatus);
router.patch("/:id/priority", updatePriority);
router.patch("/:id/resolution-date", updateResolutionDate);
router.post("/:id/messages", addPlatformMessage);

export default router;
