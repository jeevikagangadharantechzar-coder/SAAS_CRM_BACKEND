import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { protect, adminCreateOnly } from "../middlewares/auth.middleware.js";
import { createTicket, getMyTickets, addTenantMessage } from "../controllers/supportTicket.controller.js";

// Support-ticket attachment upload (stores in uploads/support-tickets/)
const supportUploadDir = "uploads/support-tickets";
if (!fs.existsSync(supportUploadDir)) fs.mkdirSync(supportUploadDir, { recursive: true });

const supportStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, supportUploadDir),
  filename: (_req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9) + path.extname(file.originalname);
    cb(null, unique);
  },
});

const supportUpload = multer({
  storage: supportStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
});

const router = express.Router();

router.use(protect, adminCreateOnly);

router.get("/", getMyTickets);
router.post("/", supportUpload.single("attachment"), createTicket);
router.post("/:id/messages", addTenantMessage);

export default router;
