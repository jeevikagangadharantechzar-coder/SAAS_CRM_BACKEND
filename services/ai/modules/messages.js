import { hasPermission, noPermission, has, matchesWord, formatDateTime, plural } from "../helpers.js";

// Each channel: model name, how to read the contact name, and the inbox page it opens.
const CHANNELS = [
  { key: "whatsapp", label: "WhatsApp", model: "WhatsAppCloudMessage", contact: (m) => m.contactName || m.contactWaId },
  { key: "instagram", label: "Instagram", model: "InstagramMessage", contact: (m) => m.senderName || m.senderUsername || m.senderIgsid },
  { key: "facebook", label: "Facebook", model: "FacebookMessage", contact: (m) => m.senderName || m.senderPsid },
];

export default {
  name: "social-messages",

  match: ({ lower }) =>
    matchesWord(lower, "whatsapp|instagram|insta|facebook|messenger|dms?|inbox|unread messages?|new messages?|messages?") &&
    !has(lower, "call", "lead", "deal", "group"),

  handle: async (ctx) => {
    if (!hasPermission(ctx, "messages", "whatsapp_chat")) return noPermission("messages", "Messages");

    const { lower, dateFilter, dateLabel, models } = ctx;
    const named = CHANNELS.filter((c) => matchesWord(lower, c.key === "instagram" ? "instagram|insta" : c.key === "facebook" ? "facebook|messenger" : c.key));
    const channels = (named.length ? named : CHANNELS).filter((c) => models[c.model]);
    if (!channels.length) return null;

    // Default to unread inbound; "all messages" or a date shows everything received in that window.
    const unreadOnly = !matchesWord(lower, "all") && (!dateFilter || has(lower, "unread", "new"));

    const results = await Promise.all(channels.map(async (c) => {
      const q = { direction: "inbound", ...(unreadOnly && { read: false }), ...(dateFilter && { createdAt: dateFilter }) };
      const [count, latest] = await Promise.all([
        models[c.model].countDocuments(q),
        models[c.model].find(q).sort({ createdAt: -1 }).limit(20),
      ]);
      return { channel: c, count, latest };
    }));

    const total = results.reduce((s, r) => s + r.count, 0);
    const what = unreadOnly ? plural(total, "unread message") : `${total} ${total === 1 ? "message" : "messages"} received`;
    const parts = results.map((r) => `${r.channel.label}: ${r.count}`).join(", ");
    const message = total
      ? `You have ${what}${dateLabel}${results.length > 1 ? ` (${parts})` : ` on ${results[0].channel.label}`}.`
      : `No ${unreadOnly ? "unread " : ""}messages${dateLabel}${results.length === 1 ? ` on ${results[0].channel.label}` : ""}.`;

    const data = results
      .flatMap((r) => r.latest.map((m) => ({
        _id: m._id,
        type: "social_message",
        channel: r.channel.key,
        name: r.channel.contact(m),
        status: r.channel.label,
        detail: `${(m.body || `[${m.type}]`).slice(0, 80)} · ${formatDateTime(m.createdAt)}`,
        handledBy: null,
        createdAt: m.createdAt,
      })))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 30);

    return { intent: `messages${unreadOnly ? "-unread" : ""}`, message, data };
  },
};
