import crypto from "crypto";
import axios from "axios";
import moment from "moment";
import { getTenantModels } from "../models/tenant/index.js";

// ─── AES-256-GCM Encryption Helpers ──────────────────────────────────────────

const getEncryptionKey = () => {
  const secret = process.env.LINKEDIN_ENCRYPTION_KEY || process.env.SECRET_KEY || process.env.JWT_SECRET || "fallback_secret_32_bytes_long!!!!!";
  return crypto.createHash("sha256").update(secret).digest();
};

const encrypt = (text) => {
  if (!text) return "";
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${encrypted}:${tag}`;
};

const decrypt = (encryptedText) => {
  if (!encryptedText) return "";
  try {
    const key = getEncryptionKey();
    const [ivHex, encrypted, tagHex] = encryptedText.split(":");
    if (!ivHex || !encrypted || !tagHex) return "";
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (err) {
    console.error("IndiaMART decryption failure:", err.message);
    return "";
  }
};

// ─── Controller Methods ──────────────────────────────────────────────────────

export default {
  /**
   * GET /indiamart/integrations
   * Fetch all IndiaMART integrations for the current tenant.
   */
  getIntegrations: async (req, res) => {
    try {
      const { IndiaMartIntegration } = getTenantModels(req.tenantDB);
      const integrations = await IndiaMartIntegration.find()
        .populate("connectedBy", "firstName lastName email")
        .sort({ createdAt: -1 });

      // Return status/info but hide the encrypted API key
      const sanitized = integrations.map(item => ({
        _id: item._id,
        companyName: item.companyName,
        status: item.status,
        lastSyncAt: item.lastSyncAt,
        connectedBy: item.connectedBy,
        createdAt: item.createdAt,
      }));

      res.status(200).json({ success: true, data: sanitized });
    } catch (err) {
      console.error("IndiaMART getIntegrations error:", err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  },

  /**
   * POST /indiamart/connect
   * Connect an IndiaMART API key.
   */
  connect: async (req, res) => {
    try {
      const { companyName, apiKey } = req.body;
      if (!apiKey) {
        return res.status(400).json({ success: false, message: "API key is required" });
      }

      const { IndiaMartIntegration, AuditLog } = getTenantModels(req.tenantDB);

      // Save integration
      const integration = await IndiaMartIntegration.findOneAndUpdate(
        { tenantId: req.tenant._id, companyName: companyName || "IndiaMART Account" },
        {
          tenantId: req.tenant._id,
          connectedBy: req.user._id,
          companyName: companyName || "IndiaMART Account",
          apiKey: encrypt(apiKey),
          status: "active"
        },
        { upsert: true, new: true }
      );

      // Create AuditLog entry
      await AuditLog.create({
        action: "INDIAMART_CONNECT",
        performedBy: req.user._id || req.user.id,
        details: {
          companyName: companyName || "IndiaMART Account",
          tenantId: req.tenant._id
        }
      });

      res.status(200).json({
        success: true,
        message: "IndiaMART API key connected successfully!",
        data: {
          _id: integration._id,
          companyName: integration.companyName,
          status: integration.status,
          lastSyncAt: integration.lastSyncAt,
        }
      });
    } catch (err) {
      console.error("IndiaMART connect error:", err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  },

  /**
   * POST /indiamart/disconnect
   * Disconnect an IndiaMART integration.
   */
  disconnect: async (req, res) => {
    try {
      const { id } = req.body;
      if (!id) {
        return res.status(400).json({ success: false, message: "Integration ID is required" });
      }

      const { IndiaMartIntegration, AuditLog } = getTenantModels(req.tenantDB);

      const integration = await IndiaMartIntegration.findByIdAndUpdate(
        id,
        { status: "inactive" },
        { new: true }
      );

      if (!integration) {
        return res.status(404).json({ success: false, message: "Integration not found" });
      }

      // Create AuditLog entry
      await AuditLog.create({
        action: "INDIAMART_DISCONNECT",
        performedBy: req.user._id || req.user.id,
        details: {
          integrationId: id
        }
      });

      res.status(200).json({ success: true, message: "IndiaMART integration disconnected" });
    } catch (err) {
      console.error("IndiaMART disconnect error:", err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  },

  /**
   * POST /indiamart/sync
   * Manually sync leads from IndiaMART.
   */
  syncLeads: async (req, res) => {
    try {
      const { id } = req.body;
      const { IndiaMartIntegration, Lead, AuditLog } = getTenantModels(req.tenantDB);

      let integrationsToSync = [];
      if (id) {
        const item = await IndiaMartIntegration.findById(id);
        if (item) integrationsToSync.push(item);
      } else {
        integrationsToSync = await IndiaMartIntegration.find({ status: "active" });
      }

      if (integrationsToSync.length === 0) {
        return res.status(404).json({ success: false, message: "No active IndiaMART integration found to sync" });
      }

      let totalImported = 0;
      let totalSkippedDuplicates = 0;
      let totalFailed = 0;

      for (const integration of integrationsToSync) {
        const rawApiKey = decrypt(integration.apiKey);
        if (!rawApiKey) {
          totalFailed++;
          continue;
        }

        // IndiaMART Pull API allows max 7 days window
        let start = integration.lastSyncAt ? moment(integration.lastSyncAt) : moment().subtract(7, "days");
        let end = moment();
        if (end.diff(start, "days") > 7) {
          start = moment().subtract(7, "days");
        }

        const startTimeStr = start.format("DD-MM-YYYY HH:mm:ss");
        const endTimeStr = end.format("DD-MM-YYYY HH:mm:ss");

        try {
          const response = await axios.get("https://mapi.indiamart.com/wservce/crm/crmListing/v2/", {
            params: {
              glusr_crm_key: rawApiKey,
              start_time: startTimeStr,
              end_time: endTimeStr
            },
            timeout: 10000 // 10s timeout
          });

          const data = response.data;
          const status = data.STATUS;
          const records = data.RESPONSE;

          if ((status === "SUCCESS" || data.CODE === 200) && Array.isArray(records)) {
            for (const record of records) {
              try {
                const uniqueQueryId = record.UNIQUE_QUERY_ID;
                if (!uniqueQueryId) continue;

                // Prevent duplicates
                const existing = await Lead.findOne({ sourceId: uniqueQueryId });
                if (existing) {
                  totalSkippedDuplicates++;
                  continue;
                }

                // Base mapping fields
                const leadFields = {
                  leadName: record.SENDER_NAME || "IndiaMART Lead",
                  phoneNumber: record.SENDER_MOBILE || "N/A",
                  email: record.SENDER_EMAIL || "",
                  source: "IndiaMART",
                  sourceId: uniqueQueryId,
                  companyName: record.SENDER_COMPANY || record.SENDER_NAME || "Individual",
                  status: "Cold",
                  notes: `Product: ${record.QUERY_PRODUCT_NAME || "N/A"}\nMessage: ${record.QUERY_MESSAGE || "No message provided"}`,
                };

                // Map city and state conditionally if they exist in schema
                if (Lead.schema.paths.city) {
                  leadFields.city = record.SENDER_CITY || "";
                }
                if (Lead.schema.paths.state) {
                  leadFields.state = record.SENDER_STATE || "";
                }

                await Lead.create(leadFields);
                totalImported++;
              } catch (leadErr) {
                console.error("Failed to create IndiaMART lead:", leadErr.message);
                totalFailed++;
              }
            }
          }

          // Update sync time
          integration.lastSyncAt = new Date();
          await integration.save();
        } catch (apiErr) {
          console.error(`IndiaMART API sync error for ${integration.companyName}:`, apiErr.message);
          totalFailed++;
        }
      }

      // Create AuditLog entry
      await AuditLog.create({
        action: "INDIAMART_SYNC",
        performedBy: req.user._id || req.user.id,
        details: {
          importedCount: totalImported,
          skippedDuplicates: totalSkippedDuplicates,
          tenantId: req.tenant._id
        }
      });

      res.status(200).json({
        success: true,
        imported: totalImported,
        skippedDuplicates: totalSkippedDuplicates,
        failed: totalFailed
      });
    } catch (err) {
      console.error("IndiaMART sync error:", err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  }
};
