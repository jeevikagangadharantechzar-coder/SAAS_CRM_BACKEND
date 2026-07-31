import multer from "multer";
import path from "path";
import fs from "fs";

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = "uploads/whatsapp";
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});

const ALLOWED_MIME = new Set([
  // images
  "image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp",
  // video
  "video/mp4", "video/3gpp",
  // audio
  "audio/mpeg", "audio/mp3", "audio/ogg", "audio/aac", "audio/amr",
  "audio/opus", "audio/webm",
  // documents
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
]);

const fileFilter = (_req, file, cb) => {
  if (ALLOWED_MIME.has(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`File type "${file.mimetype}" is not supported by WhatsApp`), false);
  }
};

export const uploadWhatsApp = multer({
  storage,
  limits: { fileSize: 16 * 1024 * 1024 }, // WhatsApp's 16 MB limit
  fileFilter,
});
