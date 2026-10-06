import fs from "fs";
import path from "path";
import { getTenantModels } from "../models/tenant/index.js";
import LeadLegacy from "../models/leads.model.js";
import DealLegacy from "../models/deals.model.js";
import InvoiceLegacy from "../models/invoice.model.js";
import ExternalDocumentLegacy from "../models/externalDocument.model.js";
import UserLegacy from "../models/user.model.js";
import getDocumentAssignmentModel from "../models/documentAssignment.model.js";
import { notifyUser } from "../realtime/socket.js";
import { removeLeadDealSource } from "../utils/documentHubCleanup.js";
import mongoose from "mongoose";

const getModels = (req) => {
  if (req.tenantDB) return getTenantModels(req.tenantDB);
  return {
    Lead: LeadLegacy,
    Deal: DealLegacy,
    Invoice: InvoiceLegacy,
    ExternalDocument: ExternalDocumentLegacy,
    User: UserLegacy,
    DocumentAssignment: getDocumentAssignmentModel(req.app.locals.db), // Fallback if no tenant DB, this might be tricky, but tenant/index handles it.
  };
};

const resolveAuth = async (req, assignmentId, DocumentAssignment) => {
  const isAdmin = req.user.role?.name === "Admin";
  const userId = String(req.user._id);

  const doc = await DocumentAssignment.findById(assignmentId);
  if (!doc) throw new Error("Document assignment not found");
  
  if (!isAdmin && String(doc.assignedTo) !== userId && String(doc.assignedBy) !== userId) {
    throw new Error("Unauthorized");
  }
  
  return doc;
};

const documentHubController = {
  getAllDocuments: async (req, res) => {
    try {
      const { DocumentAssignment } = getModels(req);
      const userId = String(req.user._id);
      const isAdmin = req.user.role?.name === "Admin";
      
      const { search = "", sourceType, status, page = 1, limit = 50 } = req.query;
      
      let query = { deletedAt: null };

      if (!isAdmin) {
        // Salesman can only see documents assigned explicitly to them
        query.assignedTo = userId;
      }

      if (sourceType) {
        query.sourceType = sourceType;
      } else {
        query.sourceType = { $ne: "Invoice" };
      }

      if (status) {
        query.status = status;
      }

      if (search) {
        const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const searchRegex = escapeRegex(search.trim());
        // Allow searching by either the Document's Name or the Lead/Deal/Invoice's Name
        query.$or = [
          { documentName: { $regex: searchRegex, $options: "i" } },
          { sourceName: { $regex: searchRegex, $options: "i" } }
        ];
      }

      const totalDocs = await DocumentAssignment.countDocuments(query);
      const skip = (Number(page) - 1) * Number(limit);
      
      const docs = await DocumentAssignment.find(query)
        .populate("assignedTo", "firstName lastName")
        .populate("assignedBy", "firstName lastName")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean();

      // Normalize for frontend
      const mappedDocs = docs.map(doc => {
        return {
          id: doc._id,
          name: doc.documentName,
          path: doc.documentPath,
          type: doc.documentType,
          size: doc.documentSize,
          sourceType: doc.sourceType,
          sourceId: doc.sourceId,
          sourceName: doc.sourceName,
        uploadedBy: doc.assignedBy, // In this context, who assigned it
        assignedTo: doc.assignedTo,
        status: doc.status,
        note: doc.note,
        activity: doc.activity,
        uploadedAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        deletedAt: doc.deletedAt,
          documentId: doc.documentId
        };
      });

      res.status(200).json({
        success: true,
        data: mappedDocs,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total: totalDocs,
          totalPages: Math.ceil(totalDocs / Number(limit))
        }
      });
    } catch (error) {
      console.error("Get all documents error:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  assignDocuments: async (req, res) => {
    try {
      const { DocumentAssignment, Notification } = getModels(req);
      const { sourceType, sourceId, sourceName, documents, assignedTo, note } = req.body;
      const isAdmin = req.user.role?.name === "Admin";

      if (!isAdmin) {
        return res.status(403).json({ success: false, message: "Only Admin can assign documents" });
      }

      if (!sourceType || !sourceId || !documents || !Array.isArray(documents) || !assignedTo) {
        return res.status(400).json({ success: false, message: "Missing required fields" });
      }

      const assignments = [];
      for (const doc of documents) {
        // Prevent accidental duplicate active assignments
        const existing = await DocumentAssignment.findOne({ 
          sourceId, 
          documentId: doc.id,
          assignedTo,
          deletedAt: null // Only check active ones
        });

        if (existing) {
          return res.status(400).json({ 
            success: false, 
            message: `Document "${doc.name}" is already assigned to this salesman and is currently active.` 
          });
        }

        const newAssignment = new DocumentAssignment({
          sourceType,
          sourceId,
          documentId: doc.id,
          documentName: doc.name,
          documentPath: doc.path,
          documentType: doc.type,
          documentSize: doc.size,
          sourceName,
          assignedTo,
          assignedBy: req.user._id,
          note: note || "",
          status: "Assigned",
          activity: [
            {
              action: "Assigned",
              performedBy: req.user._id,
              role: req.user.role?.name || "Admin",
              note: note || "",
              createdAt: new Date()
            }
          ]
        });
        await newAssignment.save();
        assignments.push(newAssignment);
      }



      // Create notification for the user
      if (Notification && assignedTo) {
        const notif = await Notification.create({
          userId: assignedTo,
          createdBy: req.user._id,
          type: "admin",
          title: "New Documents Assigned",
          message: `Admin assigned ${documents.length} document(s) for review.`,
          text: `Admin assigned ${documents.length} document(s) for review.`,
          isRead: false,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        });
        notifyUser(assignedTo, "new_notification", notif);
      }

      res.status(200).json({ success: true, message: "Documents assigned successfully", count: assignments.length });
    } catch (error) {
      console.error("Assign documents error:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  getRecycleBin: async (req, res) => {
    try {
      const { DocumentAssignment } = getModels(req);
      const userId = String(req.user._id);
      const isAdmin = req.user.role?.name === "Admin";
      
      let query = { deletedAt: { $ne: null } };

      if (!isAdmin) {
        query.assignedTo = userId;
      }

      const docs = await DocumentAssignment.find(query).sort({ deletedAt: -1 }).lean();

      const mappedDocs = docs.map(doc => ({
        id: doc._id,
        name: doc.documentName,
        path: doc.documentPath,
        sourceType: doc.sourceType,
        sourceId: doc.sourceId,
        sourceName: doc.sourceName,
        documentId: doc.documentId,
        deletedAt: doc.deletedAt
      }));

      res.status(200).json({
        success: true,
        data: mappedDocs
      });
    } catch (error) {
      console.error("Get recycle bin error:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  updateDocumentStatus: async (req, res) => {
    try {
      const { DocumentAssignment, Notification } = getModels(req);
      const { id } = req.params; // DocumentAssignment ID
      const { status, note } = req.body;

      if (!status) {
        return res.status(400).json({ success: false, message: "status is required" });
      }

      if (status === "Rejected" && (!note || !note.trim())) {
        return res.status(400).json({ success: false, message: "A reason is required for rejection." });
      }

      const doc = await resolveAuth(req, id, DocumentAssignment);
      
      // Only Admin should approve/reject
      const isAdmin = req.user.role?.name === "Admin";
      
      if (!isAdmin && (status === "Approved" || status === "Rejected")) {
        return res.status(403).json({ success: false, message: "Only Admin can approve or reject" });
      }

      doc.status = status;
      
      doc.activity = doc.activity || [];
      doc.activity.push({
        action: status,
        performedBy: req.user._id,
        role: req.user.role?.name || "Unknown",
        note: note ? note.trim() : `Status changed to ${status}`,
        createdAt: new Date()
      });

      if ((status === "Approved" || status === "Rejected") && Notification) {
        // Notify Salesman
        const notif = await Notification.create({
          userId: doc.assignedTo,
          createdBy: req.user._id,
          type: "admin",
          title: `Document ${status}`,
          message: `Admin ${status.toLowerCase()} document: ${doc.documentName}${status === 'Rejected' ? `. Reason: ${note}` : ''}`,
          text: `Admin ${status.toLowerCase()} document: ${doc.documentName}`,
          isRead: false,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        });
        notifyUser(doc.assignedTo, "new_notification", notif);
      }

      if (status === "Replied" && !isAdmin && Notification && doc.assignedBy) {
        // Notify Admin
        const notif = await Notification.create({
          userId: doc.assignedBy,
          createdBy: req.user._id,
          type: "document_reply",
          title: "Document Replied",
          message: `${req.user.firstName || 'Salesman'} replied to assigned document: ${doc.documentName}`,
          text: `${req.user.firstName || 'Salesman'} replied to assigned document: ${doc.documentName}`,
          isRead: false,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        });
        notifyUser(doc.assignedBy, "new_notification", notif);
      }

      await doc.save();

      res.status(200).json({ success: true, message: "Status updated successfully" });
    } catch (error) {
      console.error("Update document status error:", error);
      const code = error.message === "Unauthorized" ? 403 : 400;
      res.status(code).json({ success: false, message: error.message });
    }
  },

  markViewed: async (req, res) => {
    try {
      const { DocumentAssignment } = getModels(req);
      const { id } = req.params;
      
      const doc = await resolveAuth(req, id, DocumentAssignment);

      // Only the assigned reviewer opening the document counts as "Viewed"
      if (doc.status === "Assigned" && String(doc.assignedTo) === String(req.user._id)) {
        await DocumentAssignment.findOneAndUpdate(
          { _id: id, status: "Assigned" },
          {
            $set: { status: "Viewed" },
            $push: {
              activity: {
                action: "Viewed",
                performedBy: req.user._id,
                role: req.user.role?.name || "Unknown",
                note: "",
                createdAt: new Date()
              }
            }
          }
        );
      }

      res.status(200).json({ success: true });
    } catch (error) {
      console.error("Mark viewed error:", error);
      const code = error.message === "Unauthorized" ? 403 : 400;
      res.status(code).json({ success: false, message: error.message });
    }
  },

  addActivity: async (req, res) => {
    try {
      const { DocumentAssignment, Notification } = getModels(req);
      const { id } = req.params;
      const { text } = req.body;

      if (!text) {
        return res.status(400).json({ success: false, message: "text is required" });
      }

      const doc = await resolveAuth(req, id, DocumentAssignment);
      
      const isSalesman = String(doc.assignedTo) === String(req.user._id);

      doc.activity = doc.activity || [];
      doc.activity.push({
        action: "Replied",
        performedBy: req.user._id,
        role: req.user.role?.name || "Unknown",
        note: text,
        createdAt: new Date()
      });

      if (isSalesman) {
        // Change status if Salesman replies and it's not already terminal
        if (doc.status !== "Approved" && doc.status !== "Rejected") {
          doc.status = "Replied";
        }
        
        // Notify Admin (assignedBy)
        if (Notification && doc.assignedBy) {
          const notif = await Notification.create({
            userId: doc.assignedBy,
            createdBy: req.user._id,
            type: "admin",
            title: "Salesman Replied",
            message: `Salesman replied to document: ${doc.documentName}`,
            text: `Salesman replied to document: ${doc.documentName}`,
            isRead: false,
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          });
          notifyUser(doc.assignedBy, "new_notification", notif);
        }
      } else {
        // Notify Salesman (assignedTo)
        if (Notification) {
          const notif = await Notification.create({
            userId: doc.assignedTo,
            createdBy: req.user._id,
            type: "admin",
            title: "Admin Replied",
            message: `Admin replied to document: ${doc.documentName}`,
            text: `Admin replied to document: ${doc.documentName}`,
            isRead: false,
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          });
          notifyUser(doc.assignedTo, "new_notification", notif);
        }
      }

      await doc.save();

      res.status(200).json({ success: true, message: "Activity added successfully" });
    } catch (error) {
      console.error("Add activity error:", error);
      const code = error.message === "Unauthorized" ? 403 : 400;
      res.status(code).json({ success: false, message: error.message });
    }
  },

  softDeleteDocument: async (req, res) => {
    try {
      const { DocumentAssignment } = getModels(req);
      const { id } = req.params;

      const doc = await resolveAuth(req, id, DocumentAssignment);
      
      if (doc.deletedAt) {
        return res.status(400).json({ success: false, message: "Assignment is already soft deleted" });
      }

      doc.deletedAt = new Date();
      await doc.save();

      res.status(200).json({ success: true, message: "Assignment moved to recycle bin" });
    } catch (error) {
      console.error("Soft delete document error:", error);
      const code = error.message === "Unauthorized" ? 403 : 400;
      res.status(code).json({ success: false, message: error.message });
    }
  },

  softDeleteSourceDocument: async (req, res) => {
    try {

      const { DocumentAssignment, Lead, Deal } = getModels(req);
      const { sourceDocId } = req.params;

      let doc = await DocumentAssignment.findOne({ documentId: sourceDocId });

      if (!doc) {
        let objId;
        try { objId = new mongoose.Types.ObjectId(sourceDocId); } catch(e) { objId = sourceDocId; }

        let sourceObj = await Lead.findOne({ $or: [{ "attachments._id": objId }, { "images._id": objId }] });
        let sourceType = "Lead";

        if (!sourceObj) {
          sourceObj = await Deal.findOne({ $or: [{ "attachments._id": objId }, { "images._id": objId }] });
          sourceType = "Deal";
        }

        if (sourceObj) {
          let file = sourceObj.attachments?.find(a => String(a._id) === String(sourceDocId)) || sourceObj.images?.find(i => String(i._id) === String(sourceDocId));
          if (file && file.path) {
             doc = await DocumentAssignment.findOne({ documentPath: file.path, sourceId: sourceObj._id });
          }
          
          if (!doc && file) {
            doc = new DocumentAssignment({
              documentId: file._id,
              documentName: file.name,
              documentPath: file.path,
              documentType: file.type || "application/octet-stream",
              documentSize: file.size || 0,
              sourceType,
              sourceId: sourceObj._id,
              sourceName: sourceType === "Lead" ? sourceObj.leadName : sourceObj.dealName,
              assignedBy: req.user._id,
              assignedTo: sourceObj.assignTo || sourceObj.assignedTo || req.user._id,
              status: "Assigned"
            });

          }
        } else {

        }
      }

      if (doc) {
        // Only Admin or the owner of the source Lead/Deal may move its file to the Recycle Bin
        if (req.user.role?.name !== "Admin") {
          const Model = doc.sourceType === "Lead" ? Lead : doc.sourceType === "Deal" ? Deal : null;
          const source = Model ? await Model.findById(doc.sourceId).select("assignTo assignedTo").lean() : null;
          if (!source || String(source.assignTo || source.assignedTo) !== String(req.user._id)) {
            return res.status(403).json({ success: false, message: "Unauthorized" });
          }
        }

        if (doc.isNew) {
          doc.deletedAt = new Date();
          await doc.save();
        } else {
          await DocumentAssignment.updateMany(
            { documentId: doc.documentId, deletedAt: null },
            { $set: { deletedAt: new Date() } }
          );
        }

        return res.status(200).json({ success: true, message: "Assignment moved to recycle bin" });
      }

      return res.status(404).json({ success: false, message: "No document found to delete" });
    } catch (error) {
      console.error("Soft delete source document error:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  restoreDocument: async (req, res) => {
    try {
      const { DocumentAssignment } = getModels(req);
      const { id } = req.params;

      const doc = await resolveAuth(req, id, DocumentAssignment);
      
      if (!doc.deletedAt) {
        return res.status(400).json({ success: false, message: "Assignment is not in recycle bin" });
      }

      doc.deletedAt = null;
      await doc.save();

      // IMPORTANT: Unified restore — we must also undelete it from the Lead/Deal array!
      const { Lead, Deal } = getModels(req);
      if (doc.sourceType === "Lead") {
        await Lead.updateOne(
          { _id: doc.sourceId },
          { 
            $set: { 
              "attachments.$[elem].isDeleted": false,
              "images.$[elem].isDeleted": false
            } 
          },
          { arrayFilters: [{ "elem._id": doc.documentId }] }
        ).catch(() => {});
      } else if (doc.sourceType === "Deal") {
        await Deal.updateOne(
          { _id: doc.sourceId },
          { 
            $set: { 
              "attachments.$[elem].isDeleted": false,
              "images.$[elem].isDeleted": false
            } 
          },
          { arrayFilters: [{ "elem._id": doc.documentId }] }
        ).catch(() => {});
      }

      res.status(200).json({ success: true, message: "Assignment restored successfully" });
    } catch (error) {
      console.error("Restore document error:", error);
      const code = error.message === "Unauthorized" ? 403 : 400;
      res.status(code).json({ success: false, message: error.message });
    }
  },

  permanentDeleteDocument: async (req, res) => {
    try {
      const { DocumentAssignment } = getModels(req);
      const { id } = req.params;
      const isAdmin = req.user.role?.name === "Admin";

      if (!isAdmin) {
        return res.status(403).json({ success: false, message: "Only Admin can permanently delete" });
      }

      const doc = await DocumentAssignment.findById(id);
      if(!doc) {
          return res.status(404).json({ success: false, message: "Assignment not found" });
      }
      
      if (!doc.deletedAt) {
        return res.status(400).json({ success: false, message: "Must soft delete first before permanent delete" });
      }

      // Remove the source Lead/Deal attachment and its file (shared with the 30-day purge cron)
      await removeLeadDealSource(getModels(req), doc);

      await DocumentAssignment.findByIdAndDelete(id);

      res.status(200).json({ success: true, message: "Assignment and source file permanently deleted" });
    } catch (error) {
      console.error("Permanent delete error:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  uploadExternalDocument: async (req, res) => {
    try {
      const { ExternalDocument, DocumentAssignment, Notification } = getModels(req);
      const { name, assignedTo, note } = req.body;
      const isAdmin = req.user.role?.name === "Admin";

      if (!isAdmin) {
         return res.status(403).json({ success: false, message: "Only Admin can upload and assign external documents" });
      }

      if (!req.file) {
        return res.status(400).json({ success: false, message: "File is required" });
      }
      if (!name || !assignedTo) {
        return res.status(400).json({ success: false, message: "Name and assignedTo are required" });
      }

      const newDoc = new ExternalDocument({
        name,
        path: `/uploads/documents/${req.file.filename}`,
        type: req.file.mimetype,
        size: req.file.size,
        uploadedBy: req.user._id,
        assignedTo,
      });

      await newDoc.save();

      const newAssignment = new DocumentAssignment({
        sourceType: "External",
        sourceId: newDoc._id,
        documentId: newDoc._id,
        documentName: newDoc.name,
        documentPath: newDoc.path,
        documentType: newDoc.type,
        documentSize: newDoc.size,
        sourceName: "External Document",
        assignedTo,
        assignedBy: req.user._id,
        note: note || "",
        status: "Assigned",
        activity: [
          {
            action: "Assigned",
            performedBy: req.user._id,
            role: req.user.role?.name || "Admin",
            note: note || "",
            createdAt: new Date()
          }
        ]
      });
      await newAssignment.save();
      
      if (Notification) {
        const notif = await Notification.create({
          userId: assignedTo,
          createdBy: req.user._id,
          type: "admin",
          title: "New External Document Assigned",
          message: `Admin assigned external document: ${name}`,
          text: `Admin assigned external document: ${name}`,
          isRead: false,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        });
        notifyUser(assignedTo, "new_notification", notif);
      }

      res.status(201).json({ success: true, message: "External document uploaded and assigned", data: newAssignment });
    } catch (error) {
      console.error("Upload external document error:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  serveSecureFile: async (req, res) => {
    try {
      const { Lead, Deal, ExternalDocument, DocumentAssignment } = getModels(req);
      const { sourceType, sourceId, documentId, action } = req.query;
      
      if (!sourceType || !sourceId || !documentId) {
        return res.status(400).json({ message: "Missing required parameters" });
      }

      const isAdmin = req.user.role?.name === "Admin";
      let filePath = null;
      let originalName = null;

      const checkAccess = async (ownerId) => {
        if (isAdmin || String(ownerId) === String(req.user._id)) return true;
        const assignment = await DocumentAssignment.findOne({ documentId, assignedTo: req.user._id });
        return !!assignment;
      };

      if (sourceType === "Lead") {
        const lead = await Lead.findById(sourceId).lean();
        if (!lead) return res.status(404).json({ message: "Lead not found" });
        if (!(await checkAccess(lead.assignTo))) return res.status(403).json({ message: "Access denied" });

        const file = [...(lead.attachments || []), ...(lead.images || [])].find(f => String(f._id) === documentId || f.path?.includes(documentId));
        if (!file) return res.status(404).json({ message: "File not found in Lead" });
        filePath = file.path;
        originalName = file.name;
      }
      else if (sourceType === "Deal") {
        const deal = await Deal.findById(sourceId).lean();
        if (!deal) return res.status(404).json({ message: "Deal not found" });
        if (!(await checkAccess(deal.assignedTo))) return res.status(403).json({ message: "Access denied" });

        const file = [...(deal.attachments || []), ...(deal.images || [])].find(f => String(f._id) === documentId || f.path?.includes(documentId));
        if (!file) return res.status(404).json({ message: "File not found in Deal" });
        filePath = file.path;
        originalName = file.name;
      }
      else if (sourceType === "External") {
        const extDoc = await ExternalDocument.findById(sourceId).lean();
        if (!extDoc) return res.status(404).json({ message: "External document not found" });
        if (!(await checkAccess(extDoc.assignedTo))) return res.status(403).json({ message: "Access denied" });
        
        filePath = extDoc.path;
        originalName = extDoc.name;
      }
      else {
        return res.status(400).json({ message: "Invalid sourceType" });
      }

      if (!filePath) return res.status(404).json({ message: "File path not resolved" });

      let relativePath = filePath;
      const uploadsIndex = filePath.indexOf('uploads');
      if (uploadsIndex !== -1) relativePath = filePath.substring(uploadsIndex);

      const fullPath = path.resolve(process.cwd(), relativePath);
      const uploadsDir = path.resolve(process.cwd(), 'uploads');

      if (!fullPath.startsWith(uploadsDir + path.sep)) return res.status(403).json({ message: "Access denied" });
      if (!fs.existsSync(fullPath)) return res.status(404).json({ message: "File not found on disk" });

      if (action === "download") {
         res.download(fullPath, originalName);
      } else {
         const ext = path.extname(fullPath).toLowerCase();
         const contentTypes = {
            '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
            '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
            '.svg': 'image/svg+xml', '.csv': 'text/csv', '.txt': 'text/plain', '.json': 'application/json'
         };
         res.setHeader("Content-Type", contentTypes[ext] || "application/octet-stream");
         // ASCII fallback + RFC 5987 UTF-8 name: raw non-Latin names make setHeader throw
         const asciiName = String(originalName || "file").replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "");
         res.setHeader("Content-Disposition", `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(originalName || "file")}`);
         res.setHeader("Cache-Control", "private, max-age=3600");
         const stream = fs.createReadStream(fullPath);
         stream.pipe(res);
      }

    } catch (error) {
      console.error("Secure serve error:", error);
      res.status(500).json({ message: error.message });
    }
  },

};

export default documentHubController;
