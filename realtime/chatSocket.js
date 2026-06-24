import { io, connectedUsers } from "./socket.js";
import { getTenantDB } from "../config/tenantDB.js";
import chatMessageSchema from "../models/schemas/chatMessageSchema.js";

// userId -> { dbName, name }
const onlineUsers = new Map();

const getChatModel = (conn) => {
  try {
    return conn.model("ChatMessage");
  } catch {
    return conn.model("ChatMessage", chatMessageSchema);
  }
};

const emitToUser = (userId, event, payload) => {
  const sockets = connectedUsers[String(userId)];
  if (sockets?.length) sockets.forEach((s) => s.emit(event, payload));
};

// If dbName provided → only broadcast to same-tenant sockets
// If no dbName → broadcast to all (safe fallback)
const broadcastStatus = (userId, dbName, isOnline) => {
  const info = onlineUsers.get(String(userId));
  for (const [uid, sockets] of Object.entries(connectedUsers)) {
    if (uid === String(userId) || !sockets?.length) continue;
    sockets.forEach((s) => {
      if (!dbName || s.handshake.auth.dbName === dbName) {
        s.emit("chat:user_status", { userId, isOnline, name: info?.name || "" });
      }
    });
  }
};

// Online users list — scoped to tenant if dbName available, otherwise all
const getOnlineUsersList = (dbName) => {
  const entries = Array.from(onlineUsers.entries());
  const filtered = dbName
    ? entries.filter(([, info]) => info?.dbName === dbName)
    : entries;
  return filtered.map(([userId, info]) => ({ userId, name: info?.name || "" }));
};

export const initChatSocket = () => {
  io.on("connection", (socket) => {
    const { userId, dbName, name } = socket.handshake.auth;
    if (!userId) return;

    const uid = String(userId);

    // Always track online status with name for display
    onlineUsers.set(uid, { dbName: dbName || null, name: name || "" });
    broadcastStatus(uid, dbName, true);
    socket.emit("chat:online_users", getOnlineUsersList(dbName));

    // ── Send message ────────────────────────────────────────────────
    socket.on("chat:send", async (data) => {
      const db = data.dbName || dbName;
      if (!db) return socket.emit("chat:error", { message: "No dbName provided" });

      try {
        const conn = await getTenantDB(db);
        const ChatMessage = getChatModel(conn);

        const msg = await ChatMessage.create({
          senderId:   uid,
          receiverId: data.receiverId,
          senderName: data.senderName || "",
          senderRole: data.senderRole || "user",
          message:    data.message || "",
          fileUrl:    data.fileUrl  || null,
          fileName:   data.fileName || null,
          fileType:   data.fileType || null,
        });

        const payload = {
          _id:        msg._id,
          senderId:   uid,
          receiverId: data.receiverId,
          senderName: data.senderName,
          senderRole: data.senderRole,
          message:    msg.message,
          fileUrl:    msg.fileUrl,
          fileName:   msg.fileName,
          fileType:   msg.fileType,
          isRead:     false,
          isPinned:   false,
          createdAt:  msg.createdAt,
        };

        emitToUser(String(data.receiverId), "chat:message", payload);
        socket.emit("chat:message_sent", payload);
      } catch (err) {
        socket.emit("chat:error", { message: err.message });
      }
    });

    // ── Typing indicators ───────────────────────────────────────────
    socket.on("chat:typing", (data) => {
      emitToUser(String(data.receiverId), "chat:typing", {
        senderId:   uid,
        senderName: data.senderName || "",
      });
    });

    socket.on("chat:stop_typing", (data) => {
      emitToUser(String(data.receiverId), "chat:stop_typing", { senderId: uid });
    });

    // ── Mark as read ────────────────────────────────────────────────
    socket.on("chat:mark_read", async (data) => {
      const db = data.dbName || dbName;
      if (!db) return;

      try {
        const conn = await getTenantDB(db);
        const ChatMessage = getChatModel(conn);

        await ChatMessage.updateMany(
          { senderId: data.senderId, receiverId: uid, isRead: false },
          { isRead: true, readAt: new Date() }
        );

        emitToUser(String(data.senderId), "chat:read_receipt", {
          readBy: uid,
          readAt: new Date(),
        });
      } catch (err) {
        console.error("chat:mark_read error:", err.message);
      }
    });

    socket.on("chat:get_online_users", () => {
      socket.emit("chat:online_users", getOnlineUsersList(dbName));
    });

    socket.on("disconnect", () => {
      onlineUsers.delete(uid);
      broadcastStatus(uid, dbName, false);
    });
  });
};

export const getOnlineUsers = (dbName) => getOnlineUsersList(dbName);
