import cron from "node-cron";
import sendEmail from "../utils/sendEmail.js";
import fs from "fs";
import { getTenantDB } from "../config/tenantDB.js";
import { getTenantModels } from "../models/tenant/index.js";
import Tenant from "../models/master/Tenant.js";
import mongoose from "mongoose";

// Legacy model
import MassEmailLegacy from "../models/massEmail.model.js";

const processScheduledEmails = async (MassEmail, label = "legacy") => {
  const now = new Date();

  const pendingEmails = await MassEmail.find({
    status: "scheduled",
    scheduledFor: { $ne: null, $lte: now },
  });

  for (const emailDoc of pendingEmails) {
    const logoUrl =
      "https://res.cloudinary.com/djpljugqo/image/upload/v1771404424/TZI_Logo-04_-_Copy-removebg-preview_o6ocur.png";

    const finalHTML = `
      <div style="background-color:#f4f6f8; padding:40px 0;">
        <div style="max-width:600px; margin:auto; background:white; padding:30px; border-radius:8px;">

          <div style="text-align:center; margin-bottom:25px;">
            <img src="${logoUrl}" alt="TZI Logo" width="180" />
          </div>

          <div style="font-size:14px; line-height:1.6; color:#333;">
            ${emailDoc.content}
          </div>

          <hr style="margin:30px 0; border:none; border-top:1px solid #eee;" />

          <div style="text-align:center; font-size:12px; color:#888;">
            © ${new Date().getFullYear()} TZI. All rights reserved.
          </div>

        </div>
      </div>
    `;

    for (const recipient of emailDoc.recipients) {
      await sendEmail({
        to: recipient,
        subject: emailDoc.subject,
        html: finalHTML,
        attachments: emailDoc.attachments,
      });
    }

    // Update status to sent
    emailDoc.status = "sent";
    await emailDoc.save();

    //  Delete attachment files after sending
    if (emailDoc.attachments && emailDoc.attachments.length > 0) {
      emailDoc.attachments.forEach((file) => {
        fs.unlink(file.path, (err) => {
          if (err) console.error("File delete error:", err);
        });
      });
    }

    console.log(` [${label}] Scheduled email sent: ${emailDoc._id}`);
  }
};

//  Runs every minute
cron.schedule("* * * * *", async () => {
  try {
    if (mongoose.connection.readyState !== 1) {
      console.log("MongoDB not connected, skipping email cron");
      return;
    }

    console.log(" Checking scheduled emails...");

    // 1. Legacy connection
    await processScheduledEmails(MassEmailLegacy, "legacy");

    // 2. Per-tenant
    let tenants = [];
    try {
      tenants = await Tenant.find({ isActive: true }).lean();
    } catch (e) {
      console.warn("EmailCron: could not load tenants:", e.message);
    }

    for (const tenant of tenants) {
      try {
        const tenantDB = await getTenantDB(tenant.dbName);
        const { MassEmail } = getTenantModels(tenantDB);
        await processScheduledEmails(MassEmail, tenant.slug);
      } catch (e) {
        console.error(`EmailCron error for tenant ${tenant.slug}:`, e.message);
      }
    }
  } catch (error) {
    console.error(" Cron email error:", error);
  }
});

export default cron;
