import cron from "node-cron";
import { getTenantDB } from "../config/tenantDB.js";
import { getTenantModels } from "../models/tenant/index.js";
import Tenant from "../models/master/Tenant.js";
import { removeLeadDealSource, deleteUploadFile } from "../utils/documentHubCleanup.js";

const TRASH_RETENTION_DAYS = 30;

const purgeTenantDocumentTrash = async (models) => {
  const { DocumentAssignment } = models;
  if (!DocumentAssignment) return;

  const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const docsToDelete = await DocumentAssignment.find({ deletedAt: { $lte: cutoff } });

  const { ExternalDocument } = models;
  const purgedIds = [];

  for (const doc of docsToDelete) {
    try {
      // 1. Remove the source: Lead/Deal attachment + file, or the External document + file
      if (doc.sourceType === "Lead" || doc.sourceType === "Deal") {
        await removeLeadDealSource(models, doc, cutoff);
      } else if (doc.sourceType === "External" && ExternalDocument) {
        const extDoc = await ExternalDocument.findById(doc.sourceId).lean();
        if (extDoc) {
          await ExternalDocument.deleteOne({ _id: doc.sourceId });
          deleteUploadFile(extDoc.path);
        }
      } else if (doc.sourceType === "Invoice") {
        // Stored copy of the sent invoice PDF (download regenerates it on demand)
        deleteUploadFile(doc.documentPath);
      }
      purgedIds.push(doc._id);
    } catch (e) {
      // Keep the assignment so the next run retries instead of orphaning its source
      console.error(`Document trash purge failed for assignment ${doc._id}:`, e.message);
    }
  }

  if (purgedIds.length) {
    await DocumentAssignment.deleteMany({ _id: { $in: purgedIds } });
  }
};

export const runDocumentTrashPurgeCron = async () => {
  let tenants = [];
  try {
    tenants = await Tenant.find({ isActive: true }).lean();
  } catch (e) {
    console.warn("DocumentTrashCron: could not load tenants:", e.message);
    return;
  }

  for (const tenant of tenants) {
    try {
      const tenantDB = await getTenantDB(tenant.dbName);
      const models = getTenantModels(tenantDB);
      await purgeTenantDocumentTrash(models);
    } catch (e) {
      console.error(`Document Trash cron error for tenant ${tenant.slug}:`, e.message);
    }
  }
};

let documentTrashCronTask = null;

export const startDocumentTrashCron = () => {
  if (documentTrashCronTask) documentTrashCronTask.stop();
  documentTrashCronTask = cron.schedule("0 4 * * *", async () => {
    try {
      await runDocumentTrashPurgeCron();
    } catch (err) {
      console.error("Document Trash purge cron error:", err);
    }
  });
  console.log(`Document Trash Purge Cron started: ${new Date().toISOString()}`);
};

startDocumentTrashCron();

process.on("SIGINT", () => { if (documentTrashCronTask) documentTrashCronTask.stop(); });
process.on("SIGTERM", () => { if (documentTrashCronTask) documentTrashCronTask.stop(); });
