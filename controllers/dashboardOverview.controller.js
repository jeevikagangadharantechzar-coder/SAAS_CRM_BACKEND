import leadsController from "./leads.controller.js";
import dealsController from "./deals.controller.js";
import invoiceController from "./invoice.controller.js";
import adminDashboardController from "./adminDashboard.controller.js";

// Runs an existing (req, res) controller and resolves with what it would
// have sent, instead of writing to a real response. Lets this aggregator
// reuse the exact same query/visibility logic as each standalone endpoint
// (getLeads, getAllDeals, getAllInvoices, getDashboardSummary) without
// duplicating it here and letting the two copies drift apart.
const capture = (controllerFn, req) =>
  new Promise((resolve, reject) => {
    const fakeRes = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ statusCode: this.statusCode, body }); },
    };
    Promise.resolve(controllerFn(req, fakeRes)).catch(reject);
  });

export default {
  // Combines the four calls the admin dashboard fires on every load
  // (leads, deals, invoices, summary) into one round trip. The individual
  // endpoints stay untouched and keep serving their own pages.
  getDashboardOverview: async (req, res) => {
    try {
      const { start, end } = req.query;
      const isAllTime = !start && !end;

      const leadsReq    = { ...req, query: isAllTime ? { overallLead: "all" } : { start, end, limit: 9999, page: 1 } };
      const dealsReq    = { ...req, query: { start, end } };
      // Deals created before the range but won inside it (e.g. a month-old
      // deal closed today) never match a plain createdAt filter. dealType=won
      // is the same switch the Deals page's custom-range filter uses to match
      // on wonAt instead — reused here so "deals won" respects the actual
      // close date rather than the creation date.
      const dealsWonReq  = { ...req, query: { start, end, dealType: "won" } };
      // Same issue, same fix, for lost deals — dealType=lost matches on
      // lostDate instead of createdAt.
      const dealsLostReq = { ...req, query: { start, end, dealType: "lost" } };
      const invoicesReq  = { ...req, query: { start, end } };
      const summaryReq   = { ...req, query: { start, end } };

      const [leadsRes, dealsRes, dealsWonRes, dealsLostRes, invoicesRes, summaryRes] = await Promise.all([
        capture(leadsController.getLeads, leadsReq),
        capture(dealsController.getAllDeals, dealsReq),
        capture(dealsController.getAllDeals, dealsWonReq),
        capture(dealsController.getAllDeals, dealsLostReq),
        capture(invoiceController.getAllInvoices, invoicesReq),
        capture(adminDashboardController.getDashboardSummary, summaryReq),
      ]);

      const failed = [leadsRes, dealsRes, dealsWonRes, dealsLostRes, invoicesRes, summaryRes].find((r) => r.statusCode >= 400);
      if (failed) return res.status(failed.statusCode).json(failed.body);

      res.status(200).json({
        leads: leadsRes.body.leads,
        deals: dealsRes.body,
        dealsWon: dealsWonRes.body,
        dealsLost: dealsLostRes.body,
        invoices: invoicesRes.body,
        summary: summaryRes.body,
      });
    } catch (error) {
      console.error("Dashboard overview error:", error);
      res.status(500).json({ message: "Server Error" });
    }
  },
};
