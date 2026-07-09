import { io, connectedUsers } from "./socket.js";
import { getTenantDB } from "../config/tenantDB.js";
import chatMessageSchema from "../models/schemas/chatMessageSchema.js";
import groupSchema from "../models/schemas/groupSchema.js";
import groupMessageSchema from "../models/schemas/groupMessageSchema.js";

// userId -> { dbName, name }
const onlineUsers = new Map();

const getChatModel = (conn) => {
  try { return conn.model("ChatMessage"); }
  catch { return conn.model("ChatMessage", chatMessageSchema); }
};

const getGroupModel = (conn) => {
  try { return conn.model("Group"); }
  catch { return conn.model("Group", groupSchema); }
};

const getGroupMessageModel = (conn) => {
  try { return conn.model("GroupMessage"); }
  catch { return conn.model("GroupMessage", groupMessageSchema); }
};

const emitToUser = (userId, event, payload) => {
  const sockets = connectedUsers[String(userId)];
  if (sockets?.length) sockets.forEach((s) => s.emit(event, payload));
};

const broadcastStatus = (userId, dbName, isOnline) => {
  const info = onlineUsers.get(String(userId));
  for (const [uid, sockets] of Object.entries(connectedUsers)) {
    if (uid === String(userId) || !sockets?.length) continue;
    sockets.forEach((s) => {
      if (!dbName || !s.handshake.auth.dbName || s.handshake.auth.dbName === dbName) {
        s.emit("chat:user_status", { userId, isOnline, name: info?.name || "" });
      }
    });
  }
};

const getOnlineUsersList = (dbName) => {
  const entries = Array.from(onlineUsers.entries());
  const filtered = dbName
    ? entries.filter(([, info]) => !info?.dbName || info.dbName === dbName)
    : entries;
  return filtered.map(([userId, info]) => ({ userId, name: info?.name || "" }));
};

export const initChatSocket = () => {
  io.on("connection", (socket) => {
    const { userId, dbName, name } = socket.handshake.auth;
    if (!userId) return;

    const uid = String(userId);

    onlineUsers.set(uid, { dbName: dbName || null, name: name || "" });
    broadcastStatus(uid, dbName, true);
    socket.emit("chat:online_users", getOnlineUsersList(dbName));

    // ── Direct message: send ─────────────────────────────────────
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
          replyTo:    data.replyTo  || undefined,
        });

        const payload = {
          _id:        msg._id,
          tempId:     data.tempId || null,
          senderId:   uid,
          receiverId: data.receiverId,
          senderName: data.senderName,
          senderRole: data.senderRole,
          message:    msg.message,
          fileUrl:    msg.fileUrl,
          fileName:   msg.fileName,
          fileType:   msg.fileType,
          replyTo:    msg.replyTo,
          reactions:  [],
          isRead:     false,
          isPinned:   false,
          isDeleted:  false,
          status:     "sent",
          createdAt:  msg.createdAt,
        };

        emitToUser(String(data.receiverId), "chat:message", payload);
        socket.emit("chat:message_sent", payload);
      } catch (err) {
        socket.emit("chat:error", { message: err.message });
      }
    });

    // ── Direct message: delete ───────────────────────────────────
    socket.on("chat:delete", async (data) => {
      const db = data.dbName || dbName;
      if (!db) return;
      try {
        const conn = await getTenantDB(db);
        const ChatMessage = getChatModel(conn);
        const msg = await ChatMessage.findById(data.messageId);
        if (!msg || String(msg.senderId) !== uid) return;
        await ChatMessage.findByIdAndUpdate(data.messageId, { isDeleted: true, message: "" });
        const payload = { messageId: data.messageId };
        emitToUser(String(msg.receiverId), "chat:deleted", payload);
        socket.emit("chat:deleted", payload);
      } catch {}
    });

    // ── Direct message: reaction ─────────────────────────────────
    socket.on("chat:react", async (data) => {
      const db = data.dbName || dbName;
      if (!db) return;
      try {
        const conn = await getTenantDB(db);
        const ChatMessage = getChatModel(conn);
        const msg = await ChatMessage.findById(data.messageId);
        if (!msg) return;
        msg.reactions = msg.reactions.filter((r) => String(r.userId) !== uid);
        if (data.emoji) msg.reactions.push({ userId: uid, emoji: data.emoji });
        await msg.save();
        const payload = { messageId: data.messageId, reactions: msg.reactions };
        const otherId = String(msg.senderId) === uid ? String(msg.receiverId) : String(msg.senderId);
        emitToUser(otherId, "chat:reacted", payload);
        socket.emit("chat:reacted", payload);
      } catch {}
    });

    // ── Typing indicators ────────────────────────────────────────
    socket.on("chat:typing", (data) => {
      emitToUser(String(data.receiverId), "chat:typing", {
        senderId:   uid,
        senderName: data.senderName || "",
      });
    });

    socket.on("chat:stop_typing", (data) => {
      emitToUser(String(data.receiverId), "chat:stop_typing", { senderId: uid });
    });

    // ── Mark as read ─────────────────────────────────────────────
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

    // ── Group: send message ──────────────────────────────────────
    socket.on("group:send", async (data) => {
      const db = data.dbName || dbName;
      if (!db || !data.groupId) return socket.emit("chat:error", { message: "Missing groupId or dbName" });

      try {
        const conn = await getTenantDB(db);
        const Group = getGroupModel(conn);
        const GroupMessage = getGroupMessageModel(conn);

        const group = await Group.findById(data.groupId);
        if (!group) return socket.emit("chat:error", { message: "Group not found" });

        const isMember = group.members.some((m) => String(m) === uid);
        if (!isMember) return socket.emit("chat:error", { message: "Not a member" });

        // Enforce admin-only messaging
        const isAdmin = group.admins.some((a) => String(a) === uid);
        if (group.onlyAdminsCanMessage && !isAdmin)
          return socket.emit("chat:error", { message: "Only admins can send messages in this group" });

        const msg = await GroupMessage.create({
          groupId:    data.groupId,
          senderId:   uid,
          senderName: data.senderName || "",
          senderRole: data.senderRole || "user",
          message:    data.message || "",
          fileUrl:    data.fileUrl  || null,
          fileName:   data.fileName || null,
          fileType:   data.fileType || null,
          replyTo:    data.replyTo  || undefined,
          readBy:     [{ userId: uid, readAt: new Date() }],
        });

        const payload = {
          _id:        msg._id,
          tempId:     data.tempId || null,
          groupId:    data.groupId,
          senderId:   uid,
          senderName: data.senderName,
          senderRole: data.senderRole,
          message:    msg.message,
          fileUrl:    msg.fileUrl,
          fileName:   msg.fileName,
          fileType:   msg.fileType,
          replyTo:    msg.replyTo,
          reactions:  [],
          readBy:     msg.readBy,
          isDeleted:  false,
          createdAt:  msg.createdAt,
        };

        // Emit to all group members
        group.members.forEach((memberId) => {
          const mId = String(memberId);
          if (mId !== uid) {
            emitToUser(mId, "group:message", payload);
          }
        });
        socket.emit("group:message_sent", payload);
      } catch (err) {
        socket.emit("chat:error", { message: err.message });
      }
    });

    // ── Group: typing ────────────────────────────────────────────
    socket.on("group:typing", async (data) => {
      const db = data.dbName || dbName;
      if (!db || !data.groupId) return;
      try {
        const conn = await getTenantDB(db);
        const Group = getGroupModel(conn);
        const group = await Group.findById(data.groupId);
        if (!group) return;
        group.members.forEach((memberId) => {
          const mId = String(memberId);
          if (mId !== uid) {
            emitToUser(mId, "group:typing", { groupId: data.groupId, senderId: uid, senderName: data.senderName || "" });
          }
        });
      } catch {}
    });

    socket.on("group:stop_typing", async (data) => {
      const db = data.dbName || dbName;
      if (!db || !data.groupId) return;
      try {
        const conn = await getTenantDB(db);
        const Group = getGroupModel(conn);
        const group = await Group.findById(data.groupId);
        if (!group) return;
        group.members.forEach((memberId) => {
          const mId = String(memberId);
          if (mId !== uid) {
            emitToUser(mId, "group:stop_typing", { groupId: data.groupId, senderId: uid });
          }
        });
      } catch {}
    });

    // ── Group: reaction ──────────────────────────────────────────
    socket.on("group:react", async (data) => {
      const db = data.dbName || dbName;
      if (!db || !data.messageId || !data.groupId) return;
      try {
        const conn = await getTenantDB(db);
        const GroupMessage = getGroupMessageModel(conn);
        const Group = getGroupModel(conn);

        const msg = await GroupMessage.findById(data.messageId);
        if (!msg) return;
        msg.reactions = msg.reactions.filter((r) => String(r.userId) !== uid);
        if (data.emoji) msg.reactions.push({ userId: uid, emoji: data.emoji });
        await msg.save();

        const group = await Group.findById(data.groupId);
        const payload = { messageId: data.messageId, groupId: data.groupId, reactions: msg.reactions };
        if (group) {
          group.members.forEach((memberId) => {
            const mId = String(memberId);
            if (mId !== uid) emitToUser(mId, "group:reacted", payload);
          });
        }
        socket.emit("group:reacted", payload);
      } catch {}
    });

    // ── Group: mark messages read + notify senders ──────────────
    socket.on("group:mark_read", async (data) => {
      const db = data.dbName || dbName;
      if (!db || !data.groupId) return;
      try {
        const conn = await getTenantDB(db);
        const Group = getGroupModel(conn);
        const GroupMessage = getGroupMessageModel(conn);

        const now = new Date();
        // Find unread messages in group not sent by current user
        const unread = await GroupMessage.find({
          groupId: data.groupId,
          "readBy.userId": { $ne: uid },
          senderId: { $ne: uid },
          isDeleted: false,
        });

        if (unread.length === 0) return;

        await GroupMessage.updateMany(
          { groupId: data.groupId, "readBy.userId": { $ne: uid }, senderId: { $ne: uid } },
          { $push: { readBy: { userId: uid, readAt: now } } }
        );

        // Notify each message's sender that this user read it
        const notified = new Set();
        for (const msg of unread) {
          const senderId = String(msg.senderId);
          if (notified.has(senderId)) continue;
          notified.add(senderId);
          // Fetch updated readBy for this message
          const updated = await GroupMessage.findById(msg._id).select("readBy");
          emitToUser(senderId, "group:read_receipt", {
            groupId: data.groupId,
            messageId: String(msg._id),
            readBy: updated?.readBy || [],
            readerId: uid,
            readerName: name || "",
            readAt: now,
          });
        }
      } catch (err) {
        console.error("group:mark_read error:", err.message);
      }
    });

    // ── Group: delete entire group (admin only) ──────────────────
    socket.on("group:delete_group", async (data) => {
      const db = data.dbName || dbName;
      if (!db || !data.groupId) return;
      try {
        const conn = await getTenantDB(db);
        const Group = getGroupModel(conn);
        const GroupMessage = getGroupMessageModel(conn);

        const group = await Group.findById(data.groupId);
        if (!group) return socket.emit("chat:error", { message: "Group not found" });

        const isAdmin = group.admins.some((a) => String(a) === uid);
        if (!isAdmin) return socket.emit("chat:error", { message: "Only admins can delete groups" });

        const memberIds = group.members.map(String);
        await Group.findByIdAndDelete(data.groupId);
        await GroupMessage.deleteMany({ groupId: data.groupId });

        const payload = { groupId: data.groupId };
        memberIds.forEach((mId) => {
          if (mId !== uid) emitToUser(mId, "group:group_deleted", payload);
        });
        socket.emit("group:group_deleted", payload);
      } catch (err) {
        socket.emit("chat:error", { message: err.message });
      }
    });

    // ── Group: delete message ────────────────────────────────────
    socket.on("group:delete", async (data) => {
      const db = data.dbName || dbName;
      if (!db || !data.messageId || !data.groupId) return;
      try {
        const conn = await getTenantDB(db);
        const GroupMessage = getGroupMessageModel(conn);
        const Group = getGroupModel(conn);

        const msg = await GroupMessage.findById(data.messageId);
        if (!msg || String(msg.senderId) !== uid) return;
        await GroupMessage.findByIdAndUpdate(data.messageId, { isDeleted: true, message: "" });

        const group = await Group.findById(data.groupId);
        const payload = { messageId: data.messageId, groupId: data.groupId };
        if (group) {
          group.members.forEach((memberId) => {
            const mId = String(memberId);
            if (mId !== uid) emitToUser(mId, "group:deleted", payload);
          });
        }
        socket.emit("group:deleted", payload);
      } catch {}
    });

    socket.on("disconnect", () => {
      onlineUsers.delete(uid);
      broadcastStatus(uid, dbName, false);
    });
  });
};

export const getOnlineUsers = (dbName) => getOnlineUsersList(dbName);
