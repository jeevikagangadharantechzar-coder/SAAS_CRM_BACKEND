import { google } from "googleapis";
import { v4 as uuidv4 } from "uuid";
import { getTenantModels } from "../models/tenant/index.js";
import sendEmail from "../utils/sendEmail.js";

const getModels = (req) => getTenantModels(req.tenantDB);

const buildOAuthClient = (user) => {
  const client = new google.auth.OAuth2(
    process.env.GMEET_CLIENT_ID,
    process.env.GMEET_CLIENT_SECRET
  );
  client.setCredentials({
    access_token:  user.googleAuth?.accessToken,
    refresh_token: user.googleAuth?.refreshToken,
    expiry_date:   user.googleAuth?.expiryDate,
  });
  return client;
};

const refreshAndSave = (client, userId, User) => {
  client.on("tokens", async (tokens) => {
    if (tokens.access_token) {
      await User.findByIdAndUpdate(userId, {
        "googleAuth.accessToken": tokens.access_token,
        "googleAuth.expiryDate":  tokens.expiry_date,
      });
    }
  });
};

const formatICS = (meeting) => {
  const toICS = (d) => new Date(d).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//CRM Meetings//EN",
    "BEGIN:VEVENT",
    `UID:${meeting._id}@crm`,
    `DTSTART:${toICS(meeting.startDateTime)}`,
    `DTEND:${toICS(meeting.endDateTime)}`,
    `SUMMARY:${meeting.title}`,
    `DESCRIPTION:${(meeting.description || "").replace(/\n/g, "\\n")}`,
    meeting.meetLink ? `LOCATION:${meeting.meetLink}` : "",
    meeting.meetLink ? `URL:${meeting.meetLink}` : "",
    "END:VEVENT", "END:VCALENDAR",
  ].filter(Boolean).join("\r\n");
};

const sendMeetingInvites = async (meeting, creatorName, creatorEmail) => {
  const recipients = [...new Set([
    ...(meeting.attendees || []),
    ...(creatorEmail ? [creatorEmail] : []),
  ])];
  console.log("sendMeetingInvites called, recipients:", recipients);
  if (!recipients.length) {
    console.log("No recipients — skipping invite emails");
    return;
  }
  const start = new Date(meeting.startDateTime).toLocaleString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
  const end = new Date(meeting.endDateTime).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit",
  });
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
      <div style="background:#2563eb;padding:24px 28px;">
        <h2 style="color:#fff;margin:0;font-size:20px;">Meeting Invitation</h2>
      </div>
      <div style="padding:28px;">
        <h3 style="margin:0 0 8px;color:#111827;">${meeting.title}</h3>
        ${meeting.description ? `<p style="color:#6b7280;margin:0 0 20px;font-size:14px;">${meeting.description}</p>` : ""}
        <table style="width:100%;margin-bottom:24px;">
          <tr><td style="color:#6b7280;font-size:13px;padding:6px 0;width:90px;">When</td>
              <td style="color:#111827;font-size:13px;font-weight:600;">${start} – ${end}</td></tr>
          <tr><td style="color:#6b7280;font-size:13px;padding:6px 0;">Organizer</td>
              <td style="color:#111827;font-size:13px;">${creatorName}</td></tr>
          ${meeting.meetLink ? `<tr><td style="color:#6b7280;font-size:13px;padding:6px 0;">Meet Link</td>
              <td style="font-size:13px;"><a href="${meeting.meetLink}" style="color:#2563eb;">${meeting.meetLink}</a></td></tr>` : ""}
        </table>
        ${meeting.meetLink ? `<a href="${meeting.meetLink}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;">Join Meeting</a>` : ""}
        <p style="color:#9ca3af;font-size:12px;margin-top:24px;">A calendar file (.ics) is attached — open it to add this meeting to your calendar.</p>
      </div>
    </div>`;

  await Promise.allSettled(
    recipients.map((email) =>
      sendEmail({
        to: email,
        subject: `Meeting Invitation: ${meeting.title}`,
        html,
        attachments: [{ filename: "meeting-invite.ics", content: formatICS(meeting), contentType: "text/calendar" }],
      })
    )
  );
};

export default {
  getMeetings: async (req, res) => {
    try {
      const { Meeting } = getModels(req);
      const isAdmin = req.user.role?.name === "Admin";
      const query = isAdmin ? {} : { attendees: req.user.email };
      const meetings = await Meeting.find(query)
        .populate("createdBy", "firstName lastName email")
        .sort({ startDateTime: 1 });
      res.json({ success: true, meetings });
    } catch (err) {
      console.error("getMeetings error:", err);
      res.status(500).json({ success: false, message: "Failed to fetch meetings" });
    }
  },

  getMeetingById: async (req, res) => {
    try {
      const { Meeting } = getModels(req);
      const meeting = await Meeting.findById(req.params.id).populate("createdBy", "firstName lastName email");
      if (!meeting) return res.status(404).json({ success: false, message: "Meeting not found" });
      res.json({ success: true, meeting });
    } catch (err) {
      res.status(500).json({ success: false, message: "Failed to fetch meeting" });
    }
  },

  createMeeting: async (req, res) => {
    try {
      const { title, description, startDateTime, endDateTime, attendees, reminderMinutes } = req.body;
      const { Meeting, User } = getModels(req);

      if (!title || !startDateTime || !endDateTime) {
        return res.status(400).json({ success: false, message: "title, startDateTime, endDateTime are required" });
      }

      const user = await User.findById(req.user._id);
      if (!user?.googleAuth?.accessToken) {
        return res.status(403).json({
          success: false,
          message: "Connect your Google account first.",
          requiresGoogleAuth: true,
        });
      }

      const oauth2Client = buildOAuthClient(user);
      refreshAndSave(oauth2Client, user._id, User);
      const calendar = google.calendar({ version: "v3", auth: oauth2Client });

      const calendarRes = await calendar.events.insert({
        calendarId: "primary",
        conferenceDataVersion: 1,
        sendUpdates: "all",
        resource: {
          summary:     title,
          description: description || "",
          start: { dateTime: new Date(startDateTime).toISOString() },
          end:   { dateTime: new Date(endDateTime).toISOString() },
          attendees: (attendees || []).map((email) => ({ email })),
          conferenceData: {
            createRequest: {
              requestId: uuidv4(),
              conferenceSolutionKey: { type: "hangoutsMeet" },
            },
          },
        },
      });

      const googleEvent = calendarRes.data;
      const meetLink =
        googleEvent.conferenceData?.entryPoints?.find((ep) => ep.entryPointType === "video")?.uri ||
        googleEvent.hangoutLink || null;

      const meeting = await Meeting.create({
        title, description,
        startDateTime:   new Date(startDateTime),
        endDateTime:     new Date(endDateTime),
        attendees:       attendees || [],
        meetLink,
        googleEventId:   googleEvent.id,
        reminderMinutes: reminderMinutes || 10,
        createdBy:       req.user._id,
        creatorEmail:    user.email,
      });

      const creatorName = `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email;
      sendMeetingInvites(meeting, creatorName, user.email).catch((e) =>
        console.error("Invite emails failed:", e.message, e)
      );

      res.status(201).json({ success: true, meeting });
    } catch (err) {
      console.error("createMeeting error:", err);
      res.status(500).json({ success: false, message: err.message || "Failed to create meeting" });
    }
  },

  updateMeeting: async (req, res) => {
    try {
      const { title, description, startDateTime, endDateTime, attendees, reminderMinutes, status } = req.body;
      const { Meeting, User } = getModels(req);

      const meeting = await Meeting.findById(req.params.id);
      if (!meeting) return res.status(404).json({ success: false, message: "Meeting not found" });

      if (meeting.googleEventId) {
        try {
          const user = await User.findById(req.user._id);
          if (user?.googleAuth?.accessToken) {
            const oauth2Client = buildOAuthClient(user);
            const calendar = google.calendar({ version: "v3", auth: oauth2Client });
            const patch = {};
            if (title)                     patch.summary     = title;
            if (description !== undefined) patch.description = description;
            if (startDateTime)             patch.start       = { dateTime: new Date(startDateTime).toISOString() };
            if (endDateTime)               patch.end         = { dateTime: new Date(endDateTime).toISOString() };
            if (attendees)                 patch.attendees   = attendees.map((e) => ({ email: e }));
            await calendar.events.patch({
              calendarId: "primary",
              eventId: meeting.googleEventId,
              resource: patch,
              sendUpdates: "all",
            });
          }
        } catch (calErr) {
          console.warn("Calendar update skipped:", calErr.message);
        }
      }

      const updated = await Meeting.findByIdAndUpdate(
        req.params.id,
        { title, description, startDateTime, endDateTime, attendees, reminderMinutes, status },
        { new: true, omitUndefined: true }
      ).populate("createdBy", "firstName lastName email");

      res.json({ success: true, meeting: updated });
    } catch (err) {
      console.error("updateMeeting error:", err);
      res.status(500).json({ success: false, message: "Failed to update meeting" });
    }
  },

  deleteMeeting: async (req, res) => {
    try {
      const { Meeting, User } = getModels(req);
      const meeting = await Meeting.findById(req.params.id);
      if (!meeting) return res.status(404).json({ success: false, message: "Meeting not found" });

      const user = await User.findById(req.user._id);
      if (user?.googleAuth?.accessToken && meeting.googleEventId) {
        try {
          const oauth2Client = buildOAuthClient(user);
          const calendar = google.calendar({ version: "v3", auth: oauth2Client });
          await calendar.events.delete({
            calendarId: "primary",
            eventId: meeting.googleEventId,
            sendUpdates: "all",
          });
        } catch (calErr) {
          console.warn("Could not delete Google Calendar event:", calErr.message);
        }
      }

      await Meeting.findByIdAndDelete(req.params.id);
      res.json({ success: true, message: "Meeting deleted" });
    } catch (err) {
      res.status(500).json({ success: false, message: "Failed to delete meeting" });
    }
  },
};
