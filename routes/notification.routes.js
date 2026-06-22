import express from "express";
import { protect } from "../middlewares/auth.middleware.js";
import notificationController from "../controllers/notification.controller.js";

const router = express.Router();



// POST /notification
router.post("/", notificationController.createNotification);

// GET  /notifications/:userId  — fetch all notifications for a user
router.get("/:userId", notificationController.getUserNotifications);

// PATCH /notifications/read/:id — mark one notification as read
router.patch("/read/:id", notificationController.markAsRead);

// DELETE /notifications/bulk — delete multiple notifications by IDs
//  Must be declared BEFORE /:id route
router.delete("/bulk", notificationController.bulkDeleteNotifications);

// DELETE /notifications/:id — delete a single notification
router.delete("/:id", notificationController.deleteNotification);

export default router;
