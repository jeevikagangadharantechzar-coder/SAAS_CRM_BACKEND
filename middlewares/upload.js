import multer from "multer";
import path from "path";
import fs from "fs";

//  Ensure all upload directories exist on startup
["uploads/deals", "uploads/leads", "uploads/users"].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const url = req.originalUrl || req.baseUrl || "";

    let uploadPath = "uploads/leads"; 

    if (url.includes("/deals")) {
      uploadPath = "uploads/deals";
    } else if (url.includes("/users")) {
      uploadPath = "uploads/users";
    } else if (url.includes("/leads")) {
      uploadPath = "uploads/leads";
    }

    // Ensure folder exists (safety net)
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }

    cb(null, uploadPath);
  },

  filename: (req, file, cb) => {
    const uniqueName =
      Date.now() +
      "-" +
      Math.round(Math.random() * 1e9) +
      path.extname(file.originalname);
    cb(null, uniqueName);
  },
});

// Voice notes: browsers often mislabel these (e.g. a WhatsApp "*.mpeg" voice
// note is reported as mimetype "video/mpeg", not "audio/*"), so the "audio"
// field is validated by extension instead of trusting the reported mimetype.
const AUDIO_EXTENSIONS = [
  ".mp3", ".wav", ".ogg", ".webm", ".m4a", ".aac",
  ".opus", ".amr", ".mpeg", ".mpga", ".mp4", ".caf", ".3gp",
];

//  Allow images + all common document types
const fileFilter = (req, file, cb) => {
  if (file.fieldname === "audio") {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.mimetype.startsWith("audio/") || AUDIO_EXTENSIONS.includes(ext)) {
      return cb(null, true);
    }
    return cb(new Error(`Audio file type "${file.mimetype || ext}" not allowed.`), false);
  }

  const allowedMimes = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/gif",
    "image/webp",
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "text/plain",
    "text/csv",
    "application/zip",
    "application/x-zip-compressed",
    "application/x-rar-compressed",
  ];

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`File type "${file.mimetype}" not allowed.`), false);
  }
};

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter,
});

//  Middleware to normalize file paths after multer saves them.
// Multer on some OS/configs saves file.path as "\uploads\leads\file.ext" or
// "/uploads/leads/file.ext" (with leading slash). We strip the leading slash
// so the DB always stores "uploads/leads/file.ext" (no leading slash, forward slashes).
// This ensures: SERVER_URL + "/" + file.path = correct URL with no double-slash.
const normalizePaths = (req, res, next) => {
  if (req.files && req.files.length > 0) {
    req.files = req.files.map((file) => ({
      ...file,
      // Normalize: replace backslashes, strip leading slash
      path: file.path
        .replace(/\\/g, "/")           // Windows backslash → forward slash
        .replace(/^\/+/, ""),          // Remove any leading slashes
    }));
  }
  if (req.file) {
    req.file = {
      ...req.file,
      path: req.file.path
        .replace(/\\/g, "/")
        .replace(/^\/+/, ""),
    };
  }
  next();
};

export { normalizePaths };
export default upload;