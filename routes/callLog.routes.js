import express from "express";
import { protect } from "../middlewares/auth.middleware.js";
import indexControllers from "../controllers/index.controllers.js";
const router = express.Router();
//  PUBLIC TRACKING ENDPOINTS (no auth required for webhooks)
// GET track call start
router.get("/track/:sessionId/start", indexControllers.callLogController.trackCallStart);
//Get track call end
router.get("/track/:sessionId/end", indexControllers.callLogController.trackCallEnd);
// POST track heartbeat
router.post("/track/:sessionId/heartbeat", indexControllers.callLogController.trackHeartbeat);
//  PROTECTED ROUTES
router.use(protect);
// POST create call log
router.post("/", indexControllers.callLogController.createCallLog);
// GET all call logs
router.get("/", indexControllers.callLogController.getCallLogs);
// GET call statistics
router.get("/stats", indexControllers.callLogController.getCallStats);
// GET call log by ID
router.get("/:id", indexControllers.callLogController.getCallLogById);
// PATCH update call log
router.patch("/:id", indexControllers.callLogController.updateCallLog);
export default router;