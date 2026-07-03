import { google } from "googleapis";
import dotenv from "dotenv";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import mime from "mime-types";
import multer from "multer";
import GmailToken from "../models/GmailToken.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isProduction = process.env.NODE_ENV === "production";
console.log(` Gmail Service: ${isProduction ? "PRODUCTION" : "DEVELOPMENT"} mode`);

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REDIRECT_URI = isProduction
  ? process.env.GMAIL_LIVE_REDIRECT_URI
  : process.env.GMAIL_REDIRECT_URI;

const _gmailConfigured = !!(CLIENT_ID && CLIENT_SECRET);

if (!_gmailConfigured) {
  console.warn("⚠️  GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET missing in .env — Gmail features disabled");
}

const requireGmailConfig = () => {
  if (!_gmailConfigured) throw new Error("Gmail OAuth is not configured. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env");
};

export const oauth2Client = _gmailConfigured
  ? new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI)
  : null;

// ─── PER-USER CLIENT CACHE ────────────────────────────────────────────────────
const clientCache = new Map(); // email -> { client, auth, expiresAt }
const CLIENT_CACHE_TTL = 45 * 60 * 1000; // 45 minutes

const ATTACHMENT_MAX_SIZE = 25 * 1024 * 1024;
const MAX_FILE_SIZE = 25 * 1024 * 1024;

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 10 },
  fileFilter: (_req, _file, cb) => cb(null, true),
});

// ─── INIT CLIENT ──────────────────────────────────────────────────────────────
export async function initializeGmailClient(email) {
  requireGmailConfig();
  if (!email) throw new Error("email is required for Gmail client initialization");

  const normalEmail = email.toLowerCase().trim();

  const cached = clientCache.get(normalEmail);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.client;
  }

  const tokenDoc = await GmailToken.findOne({ email: normalEmail, is_active: true });
  if (!tokenDoc) throw new Error(`No Gmail token found for ${email}. Please connect Gmail first.`);

  const now = new Date();
  const expiryDate = new Date(tokenDoc.expiry_date);

  const auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  auth.setCredentials({
    access_token: tokenDoc.access_token,
    refresh_token: tokenDoc.refresh_token,
    token_type: tokenDoc.token_type,
    expiry_date: expiryDate.getTime(),
    scope: tokenDoc.scope,
  });

  if (now > expiryDate) {
    console.log(` Refreshing token for ${normalEmail}...`);
    try {
      const { credentials } = await auth.refreshAccessToken();
      tokenDoc.access_token = credentials.access_token;
      tokenDoc.expiry_date = new Date(credentials.expiry_date);
      if (credentials.refresh_token) tokenDoc.refresh_token = credentials.refresh_token;
      tokenDoc.last_connected = new Date();
      await tokenDoc.save();
      auth.setCredentials(credentials);
      console.log(` Token refreshed for ${normalEmail}`);
    } catch (err) {
      tokenDoc.is_active = false;
      await tokenDoc.save();
      clientCache.delete(normalEmail);
      throw new Error("Token expired and refresh failed. Please reconnect Gmail.");
    }
  }

  const gmailClient = google.gmail({ version: "v1", auth });
  clientCache.set(normalEmail, { client: gmailClient, expiresAt: Date.now() + CLIENT_CACHE_TTL });
  console.log(` Gmail client ready for ${normalEmail}`);
  return gmailClient;
}//old one..




function invalidateClientCache(email) {
  if (email) clientCache.delete(email.toLowerCase().trim());
}

// ─── AUTH URL ─────────────────────────────────────────────────────────────────
export function generateAuthUrl(redirectUri, state) {
  requireGmailConfig();
  const scopes = [
    "https://mail.google.com/",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.readonly",
  ];
  const client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, redirectUri);
  const opts = { access_type: "offline", prompt: "consent", scope: scopes };
  if (state) opts.state = state;
  return client.generateAuthUrl(opts);
}

// ─── SAVE TOKENS ─────────────────────────────────────────────────────────────
export async function saveTokens(tokens) {
  requireGmailConfig();
  const tempClient = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  tempClient.setCredentials(tokens);

  const gmail = google.gmail({ version: "v1", auth: tempClient });
  const profile = await gmail.users.getProfile({ userId: "me" });
  const email = profile.data.emailAddress.toLowerCase().trim();

  console.log(` Saving tokens for: ${email}`);

  const expiryDate = tokens.expiry_date ? new Date(tokens.expiry_date) : new Date(Date.now() + 3600000);

  await GmailToken.updateMany({ email }, { is_active: false });

  await GmailToken.findOneAndUpdate(
    { email },
    {
      email,
      access_token: tokens.access_token,
      ...(tokens.refresh_token && { refresh_token: tokens.refresh_token }),
      token_type: tokens.token_type || "Bearer",
      expiry_date: expiryDate,
      scope: tokens.scope || "",
      is_active: true,
      last_connected: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  invalidateClientCache(email);
  console.log(` Tokens saved for ${email}`);
  return { success: true, email };
}//old one..




// ─── EXCHANGE CODE ────────────────────────────────────────────────────────────
export async function exchangeCodeForTokens(code, redirectUri) {
  requireGmailConfig();
  const tempClient = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, redirectUri);
  const { tokens } = await tempClient.getToken(code);
  const result = await saveTokens(tokens);
  return { ...tokens, email: result.email };
}




// ─── CHECK AUTH ───────────────────────────────────────────────────────────────
export async function checkAuth(email = null) {
  const query = email ? { email: email.toLowerCase().trim(), is_active: true } : { is_active: true };
  const tokenDoc = await GmailToken.findOne(query).sort({ last_connected: -1 });
  if (!tokenDoc) return { authenticated: false, message: "No Gmail account connected", email: null };

  try {
    const gmail = await initializeGmailClient(tokenDoc.email);
    const profile = await gmail.users.getProfile({ userId: "me" });
    return { authenticated: true, message: "Gmail is connected", email: tokenDoc.email, profile: profile.data };
  } catch (err) {
    tokenDoc.is_active = false;
    await tokenDoc.save();
    invalidateClientCache(tokenDoc.email);
    return { authenticated: false, message: `Auth failed: ${err.message}`, email: tokenDoc.email };
  }
}

// ─── DISCONNECT ───────────────────────────────────────────────────────────────
export async function disconnectGmail(email) {
  if (!email) throw new Error("email required");
  const normalEmail = email.toLowerCase().trim();
  await GmailToken.updateMany({ email: normalEmail }, { is_active: false });
  invalidateClientCache(normalEmail);
  return { success: true, message: `Gmail disconnected for ${normalEmail}` };
}

// ─── KEY FIX: GET LABEL COUNTS — accurate unread using messagesUnread ─────────
export async function getLabelCounts(email) {
  if (!email) throw new Error("email required");
  const gmail = await initializeGmailClient(email);

  // Fetch INBOX label separately for accurate unread count (messagesUnread field)
  const labelIds = ["INBOX", "STARRED", "IMPORTANT", "SENT", "SPAM", "TRASH", "DRAFT"];

  const results = await Promise.allSettled(
    labelIds.map((id) => gmail.users.labels.get({ userId: "me", id }))
  );

  const counts = {};
  labelIds.forEach((id, idx) => {
    const r = results[idx];
    const key = id === "DRAFT" ? "DRAFTS" : id;
    counts[key] = r.status === "fulfilled" ? (r.value.data.threadsTotal || 0) : 0;
  });

  // UNREAD count = messagesUnread from INBOX label (most accurate)
  // This is the actual unread message count, not thread count
  if (results[0].status === "fulfilled") {
    counts.UNREAD = results[0].value.data.messagesUnread || 0;
  } else {
    // Fallback: query unread messages directly
    try {
      const unreadRes = await gmail.users.messages.list({
        userId: "me",
        q: "is:unread in:inbox",
        maxResults: 1,
      });
      counts.UNREAD = unreadRes.data.resultSizeEstimate || 0;
    } catch {
      counts.UNREAD = 0;
    }
  }

  console.log(` Counts for ${email}:`, counts);
  return counts;
}

// ─── HELPER: case-insensitive header lookup ───────────────────────────────────
function getHeader(headers, name) {
  if (!headers || !Array.isArray(headers)) return "";
  const lower = name.toLowerCase();
  const found = headers.find((h) => h.name && h.name.toLowerCase() === lower);
  return found ? (found.value || "") : "";
}

// ─── LIST THREADS ─────────────────────────────────────────────────────────────
export async function listThreads(maxResults = 20, pageToken = null, label = "INBOX", email) {
  if (!email) throw new Error("email required");
  const gmail = await initializeGmailClient(email);
  const startTime = Date.now();

  // ── DRAFTS ──────────────────────────────────────────────────────────────────
  if (label === "DRAFTS") {
    const listRes = await gmail.users.drafts.list({
      userId: "me",
      maxResults,
      pageToken: pageToken || undefined,
    });

    const drafts = listRes.data.drafts || [];
    if (!drafts.length) return { threads: [], nextPageToken: null, resultSizeEstimate: 0 };

    const results = await Promise.allSettled(
      drafts.map((draft) =>
        gmail.users.messages.get({
          userId: "me",
          id: draft.message.id,
          format: "metadata",
          metadataHeaders: ["Subject", "From", "To", "Date"],
        })
      )
    );

    const threads = drafts.map((draft, idx) => {
      if (results[idx].status !== "fulfilled") return null;
      const msg = results[idx].value.data;
      const headers = msg.payload?.headers || [];
      const date = getHeader(headers, "Date");
      return {
        id: draft.id,
        threadId: draft.message?.threadId || draft.id,
        snippet: msg.snippet || "",
        subject: getHeader(headers, "Subject") || "(No Subject)",
        from: getHeader(headers, "From") || email,
        to: getHeader(headers, "To"),
        date,
        timestamp: date ? new Date(date).getTime() : Date.now(),
        unread: false,
        starred: false,
        important: false,
        isDraft: true,
        messagesCount: 1,
      };
    }).filter(Boolean);

    return { threads, nextPageToken: listRes.data.nextPageToken, resultSizeEstimate: threads.length };
  }

  // ── REGULAR LABELS ──────────────────────────────────────────────────────────
  let params = {
    userId: "me",
    maxResults,
    pageToken: pageToken || undefined,
    includeSpamTrash: label === "SPAM" || label === "TRASH",
  };

  switch (label) {
    case "INBOX":     params.labelIds = ["INBOX"]; break;
    //  UNREAD — fetch all unread (not just inbox unread)
    case "UNREAD":
      params.q = "is:unread";
      delete params.labelIds; // Don't restrict to INBOX — show ALL unread
      params.includeSpamTrash = false;
      break;
    case "STARRED":   params.labelIds = ["STARRED"]; break;
    case "IMPORTANT": params.labelIds = ["IMPORTANT"]; break;
    case "SENT":      params.labelIds = ["SENT"]; break;
    case "SPAM":      params.labelIds = ["SPAM"]; break;
    case "TRASH":     params.labelIds = ["TRASH"]; break;
    default:          params.labelIds = [label];
  }

  const listRes = await gmail.users.threads.list(params);
  const threadStubs = listRes.data.threads || [];

  if (!threadStubs.length) {
    return { threads: [], nextPageToken: listRes.data.nextPageToken, resultSizeEstimate: 0 };
  }

  //  Fetch threads in parallel with metadata for speed
  const results = await Promise.allSettled(
    threadStubs.map((t) =>
      gmail.users.threads.get({
        userId: "me",
        id: t.id,
        format: "metadata",
        metadataHeaders: ["Subject", "From", "To", "Date", "Reply-To"],
      })
    )
  );

  const threads = results.map((result, idx) => {
    const stub = threadStubs[idx];
    if (result.status !== "fulfilled") {
      return {
        id: stub.id,
        snippet: stub.snippet || "",
        subject: "(No Subject)",
        from: "Unknown",
        to: "",
        date: "",
        timestamp: 0,
        unread: false,
        starred: false,
        important: false,
        spam: false,
        trash: false,
        isDraft: false,
        messagesCount: 0,
      };
    }

    const threadData = result.value.data;
    const messages = threadData.messages || [];

    // Use first message for subject (original), last message for sender (most recent)
    const lastMsg = messages[messages.length - 1];
    const firstMsg = messages[0];

    const lastHeaders = lastMsg?.payload?.headers || [];
    const firstHeaders = firstMsg?.payload?.headers || [];

    const subject = getHeader(firstHeaders, "Subject") || getHeader(lastHeaders, "Subject") || "(No Subject)";

    let from;
    if (label === "SENT") {
      from = getHeader(lastHeaders, "To") || getHeader(firstHeaders, "To") || "Unknown";
    } else {
      from = getHeader(lastHeaders, "From") || getHeader(firstHeaders, "From") || "Unknown";
    }

    const to = getHeader(firstHeaders, "To");
    const date = getHeader(lastHeaders, "Date") || getHeader(firstHeaders, "Date");

    //  Check ALL messages in thread for unread status
    const allLabelIds = messages.flatMap((m) => m.labelIds || []);
    const lastLabelIds = lastMsg?.labelIds || firstMsg?.labelIds || [];

    return {
      id: stub.id,
      snippet: stub.snippet || threadData.snippet || "",
      subject,
      from,
      to,
      date,
      timestamp: date ? new Date(date).getTime() : 0,
      // unread = ANY message in thread has UNREAD label
      unread: allLabelIds.includes("UNREAD"),
      starred: allLabelIds.includes("STARRED"),
      important: allLabelIds.includes("IMPORTANT"),
      spam: lastLabelIds.includes("SPAM"),
      trash: lastLabelIds.includes("TRASH"),
      isDraft: lastLabelIds.includes("DRAFT"),
      messagesCount: messages.length,
    };
  }).filter(Boolean);

  threads.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  console.log(` ${email}: ${threads.length} threads for ${label} in ${Date.now() - startTime}ms`);

  return {
    threads,
    nextPageToken: listRes.data.nextPageToken,
    resultSizeEstimate: listRes.data.resultSizeEstimate || threads.length,
  };
}



// ─── GET THREAD (full content) ────────────────────────────────────────────────
export async function getThread(threadId, email) {
  if (!email) throw new Error("email required");
  const gmail = await initializeGmailClient(email);

  const res = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });

  const processedMessages = (res.data.messages || []).map((message) => {
    const headers = message.payload?.headers || [];
    const labelIds = message.labelIds || [];
    const content = extractContent(message.payload);

    return {
      id: message.id,
      snippet: message.snippet,
      subject: getHeader(headers, "Subject") || "(No Subject)",
      from: getHeader(headers, "From") || "Unknown Sender",
      to: getHeader(headers, "To"),
      date: getHeader(headers, "Date"),
      cc: getHeader(headers, "Cc"),
      bcc: getHeader(headers, "Bcc"),
      replyTo: getHeader(headers, "Reply-To"),
      body: content.text,
      htmlBody: content.html,
      attachments: content.attachments,
      hasAttachments: content.attachments.length > 0,
      unread: labelIds.includes("UNREAD"),
      starred: labelIds.includes("STARRED"),
      important: labelIds.includes("IMPORTANT"),
      spam: labelIds.includes("SPAM"),
      trash: labelIds.includes("TRASH"),
      isDraft: labelIds.includes("DRAFT"),
      labelIds,
    };
  });

  return { ...res.data, messages: processedMessages };
}

// ─── MARK AS READ ─────────────────────────────────────────────────────────────
export async function markAsRead(threadId, read = true, email) {
  const gmail = await initializeGmailClient(email);
  const res = await gmail.users.threads.modify({
    userId: "me",
    id: threadId,
    requestBody: {
      addLabelIds: read ? [] : ["UNREAD"],
      removeLabelIds: read ? ["UNREAD"] : [],
    },
  });
  return { success: true, ...res.data };
}

// ─── SEND EMAIL ───────────────────────────────────────────────────────────────
export async function sendEmailWithAttachments(to, subject, message, cc = "", bcc = "", attachments = [], files = [], email) {
  if (!email) throw new Error("email required");
  const gmail = await initializeGmailClient(email);
  const fromEmail = email;

  const emailList = processEmailList(to);
  if (!emailList.length) throw new Error(`Invalid recipient: ${to}`);

  const allAttachments = [];
  for (const att of attachments) {
    if (att.content && att.filename) {
      if (att.size > ATTACHMENT_MAX_SIZE) throw new Error(`"${att.filename}" exceeds 25MB`);
      allAttachments.push({ ...att, mimetype: att.mimetype || mime.lookup(att.filename) || "application/octet-stream" });
    }
  }
  for (const file of files) {
    if (file.buffer && file.originalname) {
      if (file.size > ATTACHMENT_MAX_SIZE) throw new Error(`"${file.originalname}" exceeds 25MB`);
      allAttachments.push({
        filename: file.originalname,
        content: file.buffer.toString("base64"),
        mimetype: file.mimetype || mime.lookup(file.originalname) || "application/octet-stream",
        size: file.size,
      });
    }
  }

  const boundary = `gmailbnd_${Date.now()}_${Math.random().toString(36).substring(2)}`;
  const nl = "\r\n";
  const ccList = processEmailList(cc).join(", ");
  const bccList = processEmailList(bcc).join(", ");

  const parts = [
    "MIME-Version: 1.0",
    `To: ${emailList.join(", ")}`,
    `From: ${fromEmail}`,
    `Subject: ${subject || "(No Subject)"}`,
  ];
  if (ccList) parts.push(`Cc: ${ccList}`);
  if (bccList) parts.push(`Bcc: ${bccList}`);
  parts.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, "");

  parts.push(`--${boundary}`, `Content-Type: text/plain; charset="UTF-8"`, "Content-Transfer-Encoding: quoted-printable", "", message || " ", "");
  parts.push(
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    "Content-Transfer-Encoding: quoted-printable",
    "",
    `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6">${(message || " ").replace(/\n/g, "<br>")}</div>`,
    ""
  );

  for (const att of allAttachments) {
    const b64 = att.content.replace(/\s/g, "").match(/.{1,76}/g)?.join(nl) || att.content;
    parts.push(
      `--${boundary}`,
      `Content-Type: ${att.mimetype}; name="${att.filename}"`,
      `Content-Disposition: attachment; filename="${att.filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      b64,
      ""
    );
  }
  parts.push(`--${boundary}--`, "");

  const raw = Buffer.from(parts.join(nl), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const startTime = Date.now();
  const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
  const duration = (Date.now() - startTime) / 1000;
  console.log(` Email sent for ${email} in ${duration.toFixed(2)}s`);
  return { success: true, id: res.data.id, threadId: res.data.threadId, labelIds: res.data.labelIds || [], sendTime: duration };
}

// sendEmail alias
export async function sendEmail(to, subject, message, cc = "", bcc = "", attachments = [], files = [], email) {
  return sendEmailWithAttachments(to, subject, message, cc, bcc, attachments, files, email);
}

// ─── SAVE DRAFT ───────────────────────────────────────────────────────────────
export async function saveDraft(to, subject, message, cc = "", bcc = "", attachments = [], files = [], email) {
  if (!email) throw new Error("email required");
  const gmail = await initializeGmailClient(email);

  const allAtts = [...attachments];
  for (const file of files) {
    if (file.buffer && file.originalname) {
      allAtts.push({ filename: file.originalname, content: file.buffer.toString("base64"), mimetype: file.mimetype, size: file.size });
    }
  }

  const boundary = `gmailbnd_${Date.now()}`;
  const nl = "\r\n";
  const parts = ["MIME-Version: 1.0", `To: ${to}`, `From: ${email}`, `Subject: ${subject || "(No Subject)"}`];
  if (cc) parts.push(`Cc: ${cc}`);
  if (bcc) parts.push(`Bcc: ${bcc}`);
  parts.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, "");
  parts.push(`--${boundary}`, `Content-Type: text/plain; charset="UTF-8"`, "Content-Transfer-Encoding: quoted-printable", "", message || " ", "");

  for (const att of allAtts) {
    const b64 = att.content.replace(/\s/g, "").match(/.{1,76}/g)?.join(nl) || att.content;
    parts.push(
      `--${boundary}`,
      `Content-Type: ${att.mimetype || "application/octet-stream"}; name="${att.filename}"`,
      `Content-Disposition: attachment; filename="${att.filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      b64,
      ""
    );
  }
  parts.push(`--${boundary}--`, "");

  const raw = Buffer.from(parts.join(nl), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const res = await gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw } } });
  return { success: true, id: res.data.id };
}

// ─── GET DRAFTS ───────────────────────────────────────────────────────────────
export async function getDrafts(maxResults = 20, email) {
  if (!email) throw new Error("email required");
  const gmail = await initializeGmailClient(email);
  const listRes = await gmail.users.drafts.list({ userId: "me", maxResults });
  const drafts = listRes.data.drafts || [];
  if (!drafts.length) return [];

  const results = await Promise.allSettled(
    drafts.map((d) =>
      gmail.users.messages.get({
        userId: "me",
        id: d.message.id,
        format: "metadata",
        metadataHeaders: ["Subject", "From", "To", "Date"],
      })
    )
  );

  return drafts.map((draft, idx) => {
    if (results[idx].status !== "fulfilled") return null;
    const msg = results[idx].value.data;
    const headers = msg.payload?.headers || [];
    const date = getHeader(headers, "Date");
    return {
      id: draft.id,
      threadId: draft.message?.threadId,
      snippet: msg.snippet || "",
      subject: getHeader(headers, "Subject") || "(No Subject)",
      from: getHeader(headers, "From") || email,
      to: getHeader(headers, "To"),
      date,
      timestamp: date ? new Date(date).getTime() : Date.now(),
      unread: false,
      starred: false,
      important: false,
      isDraft: true,
      messagesCount: 1,
    };
  }).filter(Boolean);
}

// ─── GET DRAFT (single) ───────────────────────────────────────────────────────
export async function getDraft(draftId, email) {
  if (!email) throw new Error("email required");
  const gmail = await initializeGmailClient(email);
  const res = await gmail.users.drafts.get({ userId: "me", id: draftId, format: "full" });
  const message = res.data.message;
  const headers = message?.payload?.headers || [];
  const content = extractContent(message?.payload);
  return {
    messages: [{
      id: message.id,
      snippet: message.snippet,
      subject: getHeader(headers, "Subject") || "(No Subject)",
      from: getHeader(headers, "From"),
      to: getHeader(headers, "To"),
      cc: getHeader(headers, "Cc"),
      bcc: getHeader(headers, "Bcc"),
      date: getHeader(headers, "Date"),
      body: content.text,
      htmlBody: content.html,
      attachments: content.attachments,
      hasAttachments: content.attachments.length > 0,
      labelIds: message.labelIds || [],
      isDraft: true,
    }],
  };
}

// ─── GET ATTACHMENT ───────────────────────────────────────────────────────────
export async function getAttachment(messageId, attachmentId, email) {
  const gmail = await initializeGmailClient(email);
  const res = await gmail.users.messages.attachments.get({ userId: "me", messageId, id: attachmentId });
  return { data: res.data.data, size: res.data.size };
}

// ─── DELETE ───────────────────────────────────────────────────────────────────
export async function deleteThread(threadId, email) {
  const gmail = await initializeGmailClient(email);
  await gmail.users.threads.delete({ userId: "me", id: threadId });
  return { success: true };
}

export async function deleteEmail(messageId, email) {
  const gmail = await initializeGmailClient(email);
  await gmail.users.messages.delete({ userId: "me", id: messageId });
  return { success: true };
}

export async function deleteDraft(draftId, email) {
  const gmail = await initializeGmailClient(email);
  await gmail.users.drafts.delete({ userId: "me", id: draftId });
  return { success: true };
}

// ─── THREAD ACTIONS ───────────────────────────────────────────────────────────
export async function starThread(threadId, star = true, email) {
  const gmail = await initializeGmailClient(email);
  const res = await gmail.users.threads.modify({
    userId: "me",
    id: threadId,
    requestBody: { addLabelIds: star ? ["STARRED"] : [], removeLabelIds: star ? [] : ["STARRED"] },
  });
  return { success: true, ...res.data };
}

export async function bulkStarThreads(threadIds, star = true, email) {
  const gmail = await initializeGmailClient(email);
  const results = await Promise.allSettled(
    threadIds.map((id) =>
      gmail.users.threads.modify({
        userId: "me",
        id,
        requestBody: { addLabelIds: star ? ["STARRED"] : [], removeLabelIds: star ? [] : ["STARRED"] },
      })
    )
  );
  const successful = results.filter((r) => r.status === "fulfilled").length;
  return { success: true, message: `${star ? "Starred" : "Unstarred"} ${successful} threads`, count: successful };
}

export async function markAsSpam(threadId, spam = true, email) {
  const gmail = await initializeGmailClient(email);
  const res = await gmail.users.threads.modify({
    userId: "me",
    id: threadId,
    requestBody: { addLabelIds: spam ? ["SPAM"] : [], removeLabelIds: spam ? [] : ["SPAM"] },
  });
  return { success: true, ...res.data };
}

export async function markAsImportant(threadId, important = true, email) {
  const gmail = await initializeGmailClient(email);
  const res = await gmail.users.threads.modify({
    userId: "me",
    id: threadId,
    requestBody: { addLabelIds: important ? ["IMPORTANT"] : [], removeLabelIds: important ? [] : ["IMPORTANT"] },
  });
  return { success: true, ...res.data };
}

export async function applyLabel(threadId, labelId, email) {
  const gmail = await initializeGmailClient(email);
  const res = await gmail.users.threads.modify({
    userId: "me",
    id: threadId,
    requestBody: { addLabelIds: [labelId] },
  });
  return { success: true, ...res.data };
}

export async function moveToTrash(threadId, email) {
  const gmail = await initializeGmailClient(email);
  const res = await gmail.users.threads.trash({ userId: "me", id: threadId });
  return { success: true, ...res.data };
}

export async function bulkMoveToTrash(threadIds, email) {
  const gmail = await initializeGmailClient(email);
  const results = await Promise.allSettled(
    threadIds.map((id) => gmail.users.threads.trash({ userId: "me", id }))
  );
  const successful = results.filter((r) => r.status === "fulfilled").length;
  return { success: true, message: `Moved ${successful} threads to trash`, count: successful };
}

export async function bulkDeleteThreads(threadIds, email) {
  const gmail = await initializeGmailClient(email);
  const results = await Promise.allSettled(
    threadIds.map((id) => gmail.users.threads.delete({ userId: "me", id }))
  );
  const successful = results.filter((r) => r.status === "fulfilled").length;
  return { success: true, message: `Deleted ${successful} threads`, count: successful };
}

export async function getLabels(email) {
  const gmail = await initializeGmailClient(email);
  const res = await gmail.users.labels.list({ userId: "me" });
  return res.data.labels || [];
}

// ─── EMAIL SUGGESTIONS ────────────────────────────────────────────────────────
export async function getEmailSuggestions(query, limit = 10, email) {
  if (!email || !query || query.length < 2) return [];
  const gmail = await initializeGmailClient(email);
  const emailSet = new Set();

  const [r1, r2] = await Promise.allSettled([
    gmail.users.messages.list({ userId: "me", maxResults: 30, q: `from:${query} OR to:${query}` }),
    gmail.users.messages.list({ userId: "me", maxResults: 15, q: `in:sent ${query}` }),
  ]);

  const processMessages = async (messages = []) => {
    await Promise.allSettled(
      messages.slice(0, 8).map(async (msg) => {
        try {
          const r = await gmail.users.messages.get({
            userId: "me",
            id: msg.id,
            format: "metadata",
            metadataHeaders: ["From", "To", "Cc"],
          });
          (r.data.payload?.headers || []).forEach((h) => {
            if (["From", "To", "Cc"].includes(h.name)) {
              extractAllEmails(h.value).forEach((e) => emailSet.add(e));
            }
          });
        } catch { }
      })
    );
  };

  if (r1.status === "fulfilled") await processMessages(r1.value.data.messages || []);
  if (r2.status === "fulfilled") await processMessages(r2.value.data.messages || []);

  const lower = query.toLowerCase();
  return Array.from(emailSet).filter((e) => e.toLowerCase().includes(lower)).slice(0, limit);
}

export async function getAllActiveAccounts() {
  const accounts = await GmailToken.find({ is_active: true }).sort({ last_connected: -1 });
  return accounts.map((a) => ({ email: a.email, last_connected: a.last_connected }));
}

export async function listAllThreads(email) {
  const gmail = await initializeGmailClient(email);
  const res = await gmail.users.threads.list({ userId: "me", maxResults: 100, q: "in:inbox" });
  return (res.data.threads || []).map((t) => ({ id: t.id, snippet: t.snippet }));
}

export async function watchInbox(email) {
  await initializeGmailClient(email);
  return { historyId: Date.now().toString() };
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function extractContent(payload) {
  if (!payload) return { text: "", html: "", attachments: [] };
  let text = "", html = "";
  const attachments = [];

  function processPart(part) {
    if (!part) return;
    const mimeType = part.mimeType || "";
    const body = part.body || {};

    if (part.filename && body.attachmentId) {
      attachments.push({ id: body.attachmentId, filename: part.filename, mimeType, size: body.size || 0 });
      return;
    }

    if (mimeType === "text/plain" && body.data && !text) {
      try { text = Buffer.from(body.data, "base64").toString("utf-8"); } catch { }
    } else if (mimeType === "text/html" && body.data) {
      try { html = Buffer.from(body.data, "base64").toString("utf-8"); } catch { }
    }

    if (part.parts) part.parts.forEach(processPart);
  }

  processPart(payload);
  return { text, html, attachments };
}

function validateEmailAddress(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function processEmailList(str) {
  if (!str) return [];
  return str.split(",").map((e) => e.trim()).filter((e) => e && validateEmailAddress(e));
}

function extractAllEmails(str) {
  if (!str) return [];
  return str.match(/([a-zA-Z0-9._+-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/gi) || [];
}



