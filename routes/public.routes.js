import express from "express";
import upload from "../middlewares/upload.js";
import indexControllers from "../controllers/index.controllers.js";

const router = express.Router();

// Public contact form submit
router.post("/contact-form", upload.array("attachments", 5), indexControllers.contactFormController.submitContactForm);

export default router;
