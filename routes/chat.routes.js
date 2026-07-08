import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { protect } from "../middlewares/auth.middleware.js";
import checkPlanFeature from "../middlewares/checkPlanFeature.js";
import {
  getContacts,
  getMessages,
  markAsRead,
  getUnreadCount,
  getPinnedMessages,
  pinMessage,
  uploadChatFile,
  deleteMessage,
  addReaction,
  clearChat,
} from "../controllers/chat.controller.js";

// Chat-specific file upload (stores in uploads/chat/)
const chatUploadDir = "uploads/chat";
if (!fs.existsSync(chatUploadDir)) fs.mkdirSync(chatUploadDir, { recursive: true });

const chatStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, chatUploadDir),
  filename: (_req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9) + path.extname(file.originalname);
    cb(null, unique);
  },
});

const chatUpload = multer({
  storage: chatStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
});

const router = express.Router();

router.use(protect);
router.use(checkPlanFeature("messages"));

router.get("/contacts",                getContacts);
router.get("/messages/:userId",        getMessages);
router.post("/messages/:userId/read",  markAsRead);
router.get("/unread-count",            getUnreadCount);
router.get("/pinned/:userId",          getPinnedMessages);
router.patch("/pin/:messageId",        pinMessage);
router.post("/upload", chatUpload.single("file"), uploadChatFile);
router.delete("/messages/:messageId",        deleteMessage);
router.post("/messages/:messageId/reaction", addReaction);
router.delete("/clear/:userId",              clearChat);

export default router;
