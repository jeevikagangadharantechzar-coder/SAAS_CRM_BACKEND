import fs from "fs";
import path from "path";

// Deletes a stored upload from disk. Only paths inside uploads/ are touched; a missing file is ignored.
export const deleteUploadFile = (filePath) => {
  if (!filePath) return;
  try {
    const uploadsIndex = filePath.indexOf("uploads");
    const relativePath = uploadsIndex !== -1 ? filePath.substring(uploadsIndex) : filePath;
    const fullPath = path.resolve(process.cwd(), relativePath);
    const uploadsDir = path.resolve(process.cwd(), "uploads");
    if (!fullPath.startsWith(uploadsDir + path.sep)) return;
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  } catch (e) {
    console.error("Document file delete error:", e);
  }
};

// Permanently removes the Lead/Deal attachment (and its file on disk) behind a DocumentAssignment.
// The source is kept while another assignment for the same document is still active or still inside
// its retention window (deletedAt after `cutoff`; any other assignment counts when no cutoff is given).
// The file path is read from the Lead/Deal record, never from the assignment.
export const removeLeadDealSource = async ({ Lead, Deal, DocumentAssignment }, doc, cutoff = null) => {
  const Model = doc.sourceType === "Lead" ? Lead : doc.sourceType === "Deal" ? Deal : null;
  if (!Model || !doc.documentId) return;

  const others = { documentId: doc.documentId, _id: { $ne: doc._id } };
  if (cutoff) others.$or = [{ deletedAt: null }, { deletedAt: { $gt: cutoff } }];
  if (await DocumentAssignment.exists(others)) return;

  const source = await Model.findById(doc.sourceId).select("attachments images").lean();
  const file = source && [...(source.attachments || []), ...(source.images || [])]
    .find((f) => String(f._id) === String(doc.documentId));
  if (!file) return;

  await Model.updateOne(
    { _id: doc.sourceId },
    { $pull: { attachments: { _id: doc.documentId }, images: { _id: doc.documentId } } }
  );
  deleteUploadFile(file.path);
};
