import express from "express";
import indexControllers from "../controllers/index.controllers.js";
import { protect, adminOnly ,adminCreateOnly} from "../middlewares/auth.middleware.js";

const router = express.Router();
//create role
router.post(
  "/",
  protect,
  adminCreateOnly,
  indexControllers.roleController.createRole
);
//get all roles
router.get("/", protect, indexControllers.roleController.getRoles);
// update role by ID
router.put("/update-role/:id", protect, adminCreateOnly, indexControllers.roleController.updateRole);
//delete role by ID
router.delete("/delete-role/:id", protect, adminCreateOnly, indexControllers.roleController.deleteRole);
//update role (alternative)
router.put(
  "/:id",
  protect,
  adminCreateOnly,
  indexControllers.roleController.updateRole
);
//delete role (alternative)
router.delete(
  "/:id",
  protect,
  adminCreateOnly,
  indexControllers.roleController.deleteRole
);


export default router;



