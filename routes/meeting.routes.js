import express from "express";
import { protect, requirePermission } from "../middlewares/auth.middleware.js";
import meetingController from "../controllers/meeting.controller.js";
import checkPlanFeature from "../middlewares/checkPlanFeature.js";

const router = express.Router();

router.use(checkPlanFeature("meetings"));
router.use(protect, requirePermission("meetings"));

router.get("/", meetingController.getMeetings);
router.get("/:id", meetingController.getMeetingById);
router.post("/", meetingController.createMeeting);
router.put("/:id", meetingController.updateMeeting);
router.delete("/:id", meetingController.deleteMeeting);

export default router;
