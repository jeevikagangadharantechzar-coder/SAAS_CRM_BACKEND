import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";

// Derives a stable 32-byte AES-256 key from the existing session secret so no
// extra env var is required. SHA-256 guarantees the right key length
// regardless of the secret's original length.
const getKey = () =>
  crypto.createHash("sha256").update(process.env.SESSION_HMAC_SECRET || "").digest();

// Encrypts a plaintext string for storage at rest. Returns null for
// null/undefined/empty input so callers can store "no value" cleanly.
export const encrypt = (plainText) => {
  if (!plainText) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
};

// Reverses encrypt(). Returns null if given no ciphertext.
export const decrypt = (payload) => {
  if (!payload) return null;
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
};
