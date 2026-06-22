import express from "express";
import streakController from "../controllers/streak.controller.js";
import { protect } from "../middlewares/auth.middleware.js";

const router = express.Router();

// POST update streak on login
router.post("/update/:userId", protect, streakController.updateStreakFromLogin);
// GET user login history
router.get("/login-history/:userId", protect, streakController.getUserLoginHistory);
// GET user streak
router.get("/user/:userId", protect, streakController.getUserStreak);
// GET leaderboard
router.get("/leaderboard", protect, streakController.getLeaderboard);
// GET sales users
router.get("/sales-users", protect, streakController.getSalesUsers);

export default router;