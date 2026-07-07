import express from "express";
import { protect } from "../middlewares/auth.middleware.js";
import meetingController from "../controllers/meeting.controller.js";
import checkPlanFeature from "../middlewares/checkPlanFeature.js";

const router = express.Router();

router.use(checkPlanFeature("meetings"));

router.get("/", protect, meetingController.getMeetings);
router.get("/:id", protect, meetingController.getMeetingById);
router.post("/", protect, meetingController.createMeeting);
router.put("/:id", protect, meetingController.updateMeeting);
router.delete("/:id", protect, meetingController.deleteMeeting);

export default router;
