import express from "express";
import { protect } from "../middlewares/auth.middleware.js";
import {
  getConversations,
  syncConversations,
  getMessages,
  sendMessage,
  markRead,
  getPostComments,
  syncComments,
  replyToComment,
  hideComment,
  deleteComment,
  getLeads,
} from "../controllers/facebook.controller.js";

const router = express.Router();

router.use(protect);

// Messenger
router.get("/conversations",                    getConversations);
router.get("/conversations/sync",               syncConversations);
router.get("/messages/:senderPsid",             getMessages);
router.post("/send",                            sendMessage);
router.patch("/messages/:senderPsid/read",      markRead);

// Comments
router.get("/comments",                         getPostComments);
router.get("/comments/sync",                    syncComments);
router.post("/comments/:commentId/reply",       replyToComment);
router.post("/comments/:commentId/hide",        hideComment);
router.delete("/comments/:commentId",           deleteComment);

// Leads
router.get("/leads",                            getLeads);

export default router;
