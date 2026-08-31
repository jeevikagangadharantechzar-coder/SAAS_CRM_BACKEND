import express from "express";
import { superAdminAuth, requireSuperAdminPermission } from "../../middlewares/superAdminAuth.js";
import {
  listSuperAdminUsers,
  createSuperAdminUser,
  updateSuperAdminUser,
  deleteSuperAdminUser,
  resetSuperAdminUserPassword,
} from "../../controllers/superAdminUser.controller.js";

const router = express.Router();

router.use(superAdminAuth, requireSuperAdminPermission("admin_users"));

router.get("/", listSuperAdminUsers);
router.post("/", createSuperAdminUser);
router.put("/:id", updateSuperAdminUser);
router.delete("/:id", deleteSuperAdminUser);
router.post("/:id/reset-password", resetSuperAdminUserPassword);

export default router;
