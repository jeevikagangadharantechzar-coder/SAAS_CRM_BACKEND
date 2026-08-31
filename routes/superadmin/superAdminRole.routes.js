import express from "express";
import { superAdminAuth, requireSuperAdminPermission } from "../../middlewares/superAdminAuth.js";
import {
  listSuperAdminRoles,
  getSuperAdminRoleById,
  createSuperAdminRole,
  updateSuperAdminRole,
  deleteSuperAdminRole,
} from "../../controllers/superAdminRole.controller.js";

const router = express.Router();

router.use(superAdminAuth, requireSuperAdminPermission("admin_users"));

router.get("/", listSuperAdminRoles);
router.get("/:id", getSuperAdminRoleById);
router.post("/", createSuperAdminRole);
router.put("/:id", updateSuperAdminRole);
router.delete("/:id", deleteSuperAdminRole);

export default router;
