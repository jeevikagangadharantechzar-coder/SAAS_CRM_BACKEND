import express from "express";
import indexControllers from "../controllers/index.controllers.js";
import { protect } from "../middlewares/auth.middleware.js";
import checkPlanFeature from "../middlewares/checkPlanFeature.js";

const router = express.Router();

router.use(protect);
// Whole module gated on the tenant's plan, same pattern as deals.route.js —
// this was previously missing entirely, meaning a plan disabling the
// Calendar feature had no effect on the actual API.
router.use(checkPlanFeature("schedule_view"));

// GET /calendar?start=&end= — merged, role-scoped feed across tasks,
// targets, deal follow-ups, invoices, proposals, meetings, and scheduled
// emails, for the Schedule page.
router.get("/", indexControllers.calendarController.getCalendarEvents);

// Personal sticky notes pinned to a date — private per user
router.post("/notes", indexControllers.calendarController.addCalendarNote);
router.put("/notes/:id", indexControllers.calendarController.updateCalendarNote);
router.delete("/notes/:id", indexControllers.calendarController.deleteCalendarNote);

export default router;
