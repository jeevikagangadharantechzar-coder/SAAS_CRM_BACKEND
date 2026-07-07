import express from "express";
import { protect } from "../middlewares/auth.middleware.js";
import checkPlanFeature from "../middlewares/checkPlanFeature.js";
import {
  createGroup,
  getGroups,
  getGroupById,
  updateGroup,
  addMembers,
  removeMember,
  leaveGroup,
  deleteGroup,
  getGroupMessages,
  markGroupRead,
  clearGroupChat,
} from "../controllers/group.controller.js";

const router = express.Router();

router.use(protect);
router.use(checkPlanFeature("messages"));

router.post("/",                              createGroup);
router.get("/",                               getGroups);
router.get("/:groupId",                       getGroupById);
router.patch("/:groupId",                     updateGroup);
router.delete("/:groupId",                    deleteGroup);
router.post("/:groupId/members",              addMembers);
router.delete("/:groupId/members/:memberId",  removeMember);
router.post("/:groupId/leave",                leaveGroup);
router.get("/:groupId/messages",              getGroupMessages);
router.post("/:groupId/read",                 markGroupRead);
router.delete("/:groupId/clear",              clearGroupChat);

export default router;
