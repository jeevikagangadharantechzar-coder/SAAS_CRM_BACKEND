import express from "express";
import streakController from "../controllers/streak.controller.js";
import { protect, requirePermission } from "../middlewares/auth.middleware.js";

const router = express.Router();

// POST update streak on login — must keep working for every login regardless
// of leaderboard permission, so this and the read-your-own-streak routes
// below are intentionally left ungated; only the leaderboard *view* itself
// (which shows everyone's standings) requires the permission.
router.post("/update/:userId", protect, streakController.updateStreakFromLogin);
// GET user login history
router.get("/login-history/:userId", protect, streakController.getUserLoginHistory);
// GET user streak
router.get("/user/:userId", protect, streakController.getUserStreak);
// GET leaderboard
router.get("/leaderboard", protect, requirePermission("streak_leaderboard"), streakController.getLeaderboard);
// GET sales users
router.get("/sales-users", protect, requirePermission("streak_leaderboard"), streakController.getSalesUsers);

export default router;