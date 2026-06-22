import express from "express";
import { protect } from "../middlewares/auth.middleware.js";
import indexControllers from "../controllers/index.controllers.js";


const router = express.Router();

//  Admin check middleware
const isAdmin = (req, res, next) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({
      message: "Admin access required",
    });
  }
  next();
};

//  Admin + assigned users can VIEW templates
router.get("/", protect, indexControllers.emailTemplateController.getTemplates);

//  Only admin can CREATE templates
router.post("/", protect, isAdmin, indexControllers.emailTemplateController.createTemplate);

export default router;
