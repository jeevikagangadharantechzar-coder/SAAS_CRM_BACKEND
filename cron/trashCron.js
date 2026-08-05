// Permanently purges leads/deals that have sat in Trash (trash: true) for 30+
// days, across every active tenant — mirrors the tenant-loop pattern in
// cron/taskCron.js. Only ever touches documents already flagged trash: true;
// trashedAt (set when an item is moved to trash, cleared on restore) is the
// sole age signal, so a restored item is never at risk of this sweep.
import cron from "node-cron";
import { getTenantDB } from "../config/tenantDB.js";
import { getTenantModels } from "../models/tenant/index.js";
import Tenant from "../models/master/Tenant.js";

const TRASH_RETENTION_DAYS = 30;

const purgeTenantTrash = async (models) => {
  const { Lead, Deal, Notification } = models;
  const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  if (Lead) {
    const expiredLeadIds = await Lead.find({ trash: true, trashedAt: { $lte: cutoff } }).distinct("_id");
    if (expiredLeadIds.length) {
      if (Notification) {
        await Notification.deleteMany({ "meta.leadId": { $in: expiredLeadIds.map(String) } });
      }
      await Lead.deleteMany({ _id: { $in: expiredLeadIds } });
      console.log(`Trash cron: purged ${expiredLeadIds.length} lead(s) past ${TRASH_RETENTION_DAYS}-day retention`);
    }
  }

  if (Deal) {
    const expiredDealIds = await Deal.find({ trash: true, trashedAt: { $lte: cutoff } }).distinct("_id");
    if (expiredDealIds.length) {
      if (Notification) {
        await Notification.deleteMany({ "meta.dealId": { $in: expiredDealIds.map(String) } });
      }
      await Deal.deleteMany({ _id: { $in: expiredDealIds } });
      console.log(`Trash cron: purged ${expiredDealIds.length} deal(s) past ${TRASH_RETENTION_DAYS}-day retention`);
    }
  }
};

export const runTrashPurgeCron = async () => {
  let tenants = [];
  try {
    tenants = await Tenant.find({ isActive: true }).lean();
  } catch (e) {
    console.warn("TrashCron: could not load tenants:", e.message);
    return;
  }

  for (const tenant of tenants) {
    try {
      const tenantDB = await getTenantDB(tenant.dbName);
      const models = getTenantModels(tenantDB);
      await purgeTenantTrash(models);
    } catch (e) {
      console.error(`Trash cron error for tenant ${tenant.slug}:`, e.message);
    }
  }
};

let trashCronTask = null;

export const startTrashCron = () => {
  if (trashCronTask) trashCronTask.stop();
  // Once a day is plenty for a 30-day retention window.
  trashCronTask = cron.schedule("0 3 * * *", async () => {
    try {
      await runTrashPurgeCron();
    } catch (err) {
      console.error("Trash purge cron error:", err);
    }
  });
  console.log(`Trash Purge Cron started: ${new Date().toISOString()}`);

  runTrashPurgeCron().catch((err) => console.error("Initial trash purge run error:", err));
};

startTrashCron();

process.on("SIGINT", () => { if (trashCronTask) trashCronTask.stop(); });
process.on("SIGTERM", () => { if (trashCronTask) trashCronTask.stop(); });
