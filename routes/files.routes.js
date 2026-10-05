import express from "express";
import { protect } from "../middlewares/auth.middleware.js";
import fs from "fs";
import path from "path";
import { getTenantModels } from "../models/tenant/index.js";
import LeadLegacy from "../models/leads.model.js";
import DealLegacy from "../models/deals.model.js";
import ExternalDocumentLegacy from "../models/externalDocument.model.js";

const router = express.Router();

const getModels = (req) => {
  if (req.tenantDB) return getTenantModels(req.tenantDB);
  return {
    Lead: LeadLegacy,
    Deal: DealLegacy,
    ExternalDocument: ExternalDocumentLegacy,
  };
};

const authorizeFileAccess = async (req, relativePath) => {
  const isAdmin = req.user.role?.name === "Admin";
  if (isAdmin) return true;

  const { Lead, Deal, ExternalDocument } = getModels(req);
  const userId = String(req.user._id);
  const searchPath = { $regex: relativePath.replace(/\\/g, '/').split('/').pop() + "$" }; // Match end of path

  if (relativePath.includes("uploads/leads") || relativePath.includes("uploads\\leads")) {
    const lead = await Lead.findOne({
      $or: [
        { "attachments.path": searchPath },
        { "images.path": searchPath },
        { "followUpNotes.audio": searchPath }
      ]
    }).lean();
    if (lead && String(lead.assignTo) !== userId) return false;
  } else if (relativePath.includes("uploads/deals") || relativePath.includes("uploads\\deals")) {
    const deal = await Deal.findOne({
      $or: [
        { "attachments.path": searchPath },
        { "images.path": searchPath }
      ]
    }).lean();
    if (deal && String(deal.assignedTo) !== userId) return false;
  } else if (relativePath.includes("uploads/documents") || relativePath.includes("uploads\\documents")) {
    const extDoc = await ExternalDocument.findOne({ path: searchPath }).lean();
    if (extDoc && String(extDoc.assignedTo) !== userId && String(extDoc.uploadedBy) !== userId) return false;
  }
  
  return true; // Default to allow if it's a generic file (like user avatar) or not found in restricted folders
};

// Existing download route
router.get("/download", protect, async (req, res) => {
  try {
    const { filePath } = req.query;
    
    if (!filePath) {
      return res.status(400).json({ message: "File path is required" });
    }

    // Extract relative path from "uploads" onwards if an absolute path is provided
    let relativePath = filePath;
    const uploadsIndex = filePath.indexOf('uploads');
    if (uploadsIndex !== -1) {
      relativePath = filePath.substring(uploadsIndex);
    }

    // Security check: Ensure the file path is within your uploads directory safely
    const fullPath = path.resolve(process.cwd(), relativePath);
    const uploadsDir = path.resolve(process.cwd(), 'uploads');
    
    // In Windows, paths might use backslashes, so standardizing helps
    if (!fullPath.startsWith(uploadsDir)) {
      return res.status(403).json({ message: "Access denied" });
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ message: "File not found" });
    }

    const isAuthorized = await authorizeFileAccess(req, relativePath);
    if (!isAuthorized) {
      return res.status(403).json({ message: "Not authorized to access this file" });
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ message: "File not found" });
    }

    const fileName = path.basename(fullPath);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    
    const fileStream = fs.createReadStream(fullPath);
    fileStream.pipe(res);
  } catch (error) {
    console.error("File download error:", error);
    res.status(500).json({ message: "Server error" });
  }
});


router.get("/preview", protect, async (req, res) => {
  try {
    const { filePath } = req.query;
    
    if (!filePath) {
      return res.status(400).json({ message: "File path is required" });
    }

    // Extract relative path from "uploads" onwards if an absolute path is provided
    let relativePath = filePath;
    const uploadsIndex = filePath.indexOf('uploads');
    if (uploadsIndex !== -1) {
      relativePath = filePath.substring(uploadsIndex);
    }

    // Security check: Ensure the file path is within your uploads directory safely
    const fullPath = path.resolve(process.cwd(), relativePath);
    const uploadsDir = path.resolve(process.cwd(), 'uploads');
    
    if (!fullPath.startsWith(uploadsDir)) {
      return res.status(403).json({ message: "Access denied" });
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ message: "File not found" });
    }

    const isAuthorized = await authorizeFileAccess(req, relativePath);
    if (!isAuthorized) {
      return res.status(403).json({ message: "Not authorized to access this file" });
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ message: "File not found" });
    }

    const fileName = path.basename(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    
    // Set proper content type for preview
    const contentTypes = {
      '.pdf': 'application/pdf',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.txt': 'text/plain',
      '.csv': 'text/csv',
      '.json': 'application/json',
      '.xml': 'application/xml',
      '.webm': 'audio/webm',
      '.ogg': 'audio/ogg',
      '.mp3': 'audio/mpeg',
      '.mpeg': 'audio/mpeg',
      '.mpga': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.m4a': 'audio/mp4',
      '.aac': 'audio/aac',
      '.opus': 'audio/opus',
      '.amr': 'audio/amr',
      '.caf': 'audio/x-caf',
      '.3gp': 'audio/3gpp',
    };
    
    const contentType = contentTypes[ext] || 'application/octet-stream';
    
    // KEY DIFFERENCE: Use 'inline' instead of 'attachment'
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.setHeader('Content-Type', contentType);
    
    // Optional: Add cache control for better performance
    res.setHeader('Cache-Control', 'public, max-age=3600');
    
    const fileStream = fs.createReadStream(fullPath);
    fileStream.pipe(res);
  } catch (error) {
    console.error("File preview error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;