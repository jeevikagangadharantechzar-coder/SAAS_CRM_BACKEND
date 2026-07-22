import express from "express";
import { protect } from "../middlewares/auth.middleware.js";
import notificationController from "../controllers/notification.controller.js";

const router = express.Router();

router.use(protect);

// GET /notifications — current user's notifications (Admin: tenant-wide, Sales: own only).
// Identity comes from the verified JWT (req.user), not a URL param.
// Must be declared BEFORE /:userId so it isn't swallowed by that route.
router.get("/", notificationController.getNotificationsForCurrentUser);

// POST /notification
router.post("/", notificationController.createNotification);

// GET  /notifications/:userId  — fetch all notifications for a user (legacy, kept for compatibility)
router.get("/:userId", notificationController.getUserNotifications);

// PATCH /notifications/read/:id — mark one notification as read
router.patch("/read/:id", notificationController.markAsRead);

// DELETE /notifications/bulk — delete multiple notifications by IDs
//  Must be declared BEFORE /:id route
router.delete("/bulk", notificationController.bulkDeleteNotifications);

// DELETE /notifications/:id — delete a single notification
router.delete("/:id", notificationController.deleteNotification);

export default router;
