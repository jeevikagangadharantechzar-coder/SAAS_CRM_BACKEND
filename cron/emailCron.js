import cron from "node-cron";
import sendEmail from "../utils/sendEmail.js";
import fs from "fs";
import { getTenantDB } from "../config/tenantDB.js";
import { getTenantModels } from "../models/tenant/index.js";
import Tenant from "../models/master/Tenant.js";
import mongoose from "mongoose";
import { sendNotification } from "../services/notificationService.js";

// Legacy model
import MassEmailLegacy from "../models/massEmail.model.js";

const notifyScheduledEmailOutcome = async (emailDoc, outcome, tenantDB, errorMessage) => {
  if (!emailDoc.createdBy) return;
  try {
    await sendNotification(
      emailDoc.createdBy,
      outcome === "sent"
        ? `Your scheduled email "${emailDoc.subject}" was sent to ${emailDoc.recipients.length} recipient(s).`
        : `Your scheduled email "${emailDoc.subject}" failed to send${errorMessage ? `: ${errorMessage}` : "."}`,
      "scheduled_email",
      { massEmailId: String(emailDoc._id), outcome },
      { referenceId: `${emailDoc._id}:${outcome}`, title: outcome === "sent" ? "Scheduled Email Sent" : "Scheduled Email Failed" },
      tenantDB
    );
  } catch (notifyErr) {
    console.error("EmailCron: failed to create scheduled_email notification:", notifyErr.message);
  }
};

const processScheduledEmails = async (MassEmail, label = "legacy", tenantDB = null) => {
  const now = new Date();

  const pendingEmails = await MassEmail.find({
    status: "scheduled",
    scheduledFor: { $ne: null, $lte: now },
  });

  for (const emailDoc of pendingEmails) {
    try {
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
      await notifyScheduledEmailOutcome(emailDoc, "sent", tenantDB);
    } catch (err) {
      console.error(` [${label}] Scheduled email failed: ${emailDoc._id}`, err.message);
      await notifyScheduledEmailOutcome(emailDoc, "failed", tenantDB, err.message);
    }
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
        await processScheduledEmails(MassEmail, tenant.slug, tenantDB);
      } catch (e) {
        console.error(`EmailCron error for tenant ${tenant.slug}:`, e.message);
      }
    }
  } catch (error) {
    console.error(" Cron email error:", error);
  }
});

const sendMeetingReminderEmail = async (meeting) => {
  const start = new Date(meeting.startDateTime).toLocaleString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
      <div style="background:#f59e0b;padding:24px 28px;">
        <h2 style="color:#fff;margin:0;font-size:20px;">Meeting Reminder</h2>
      </div>
      <div style="padding:28px;">
        <h3 style="margin:0 0 8px;color:#111827;">${meeting.title}</h3>
        ${meeting.description ? `<p style="color:#6b7280;margin:0 0 20px;font-size:14px;">${meeting.description}</p>` : ""}
        <p style="color:#374151;font-size:14px;">Your meeting starts in <strong>${meeting.reminderMinutes} minutes</strong>.</p>
        <table style="width:100%;margin-bottom:24px;">
          <tr><td style="color:#6b7280;font-size:13px;padding:6px 0;width:90px;">When</td>
              <td style="color:#111827;font-size:13px;font-weight:600;">${start}</td></tr>
          ${meeting.meetLink ? `<tr><td style="color:#6b7280;font-size:13px;padding:6px 0;">Meet Link</td>
              <td style="font-size:13px;"><a href="${meeting.meetLink}" style="color:#2563eb;">${meeting.meetLink}</a></td></tr>` : ""}
        </table>
        ${meeting.meetLink ? `<a href="${meeting.meetLink}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;">Join Meeting</a>` : ""}
      </div>
    </div>`;

  const recipients = [...new Set([
    ...(meeting.attendees || []),
    ...(meeting.creatorEmail ? [meeting.creatorEmail] : []),
  ])];

  await Promise.allSettled(
    recipients.map((email) =>
      sendEmail({ to: email, subject: `Reminder: ${meeting.title} starts in ${meeting.reminderMinutes} min`, html })
    )
  );
};

const processMeetingReminders = async (Meeting, label = "legacy") => {
  const now = new Date();
  const meetings = await Meeting.find({
    status: "scheduled",
    reminderSentAt: null,
  });

  for (const meeting of meetings) {
    const reminderTime = new Date(meeting.startDateTime.getTime() - (meeting.reminderMinutes || 10) * 60 * 1000);
    if (reminderTime <= now && now < new Date(meeting.startDateTime)) {
      try {
        await sendMeetingReminderEmail(meeting);
        meeting.reminderSentAt = new Date();
        await meeting.save();
        console.log(`[${label}] Meeting reminder sent: ${meeting.title}`);
      } catch (e) {
        console.error(`[${label}] Meeting reminder failed: ${meeting.title}`, e.message);
      }
    }
  }
};

// Meeting reminder cron — runs every minute
cron.schedule("* * * * *", async () => {
  try {
    if (mongoose.connection.readyState !== 1) return;

    let tenants = [];
    try { tenants = await Tenant.find({ isActive: true }).lean(); } catch (_) {}

    for (const tenant of tenants) {
      try {
        const tenantDB = await getTenantDB(tenant.dbName);
        const { Meeting } = getTenantModels(tenantDB);
        if (Meeting) await processMeetingReminders(Meeting, tenant.slug);
      } catch (e) {
        console.error(`Meeting reminder cron error for tenant ${tenant.slug}:`, e.message);
      }
    }
  } catch (error) {
    console.error("Meeting reminder cron error:", error);
  }
});

export default cron;
