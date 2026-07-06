import { Server } from "socket.io";
import Redis from "ioredis";
import { getTenantDB } from "../config/tenantDB.js";
import { getTenantModels } from "../models/tenant/index.js";
import NotificationLegacy from "../models/notification.model.js";
import { initTargetSocket } from "./targetSocket.js";

const redisConfig = {
  host: "127.0.0.1",
  port: 6379,
  enableOfflineQueue: true,
  retryStrategy: (times) => Math.min(times * 50, 2000),
};

const redisClient = new Redis(redisConfig);
const redisPub    = new Redis(redisConfig);
const redisSub    = new Redis(redisConfig);

redisClient.on("error", (err) => console.warn("Redis client:", err.message));
redisPub.on("error",    (err) => console.warn("Redis pub:",    err.message));
redisSub.on("error",    (err) => console.warn("Redis sub:",    err.message));

export const connectedUsers = {};
const offlineMessages = {};

export let io;

export const initSocket = (server) => {
  io = new Server(server, { cors: { origin: "*" } });

  // Dedicated namespace for target-management real-time events (kept separate
  // from the generic notification bell socket below).
  initTargetSocket(io);

  io.on("connection", (socket) => {
    const { userId } = socket.handshake.auth;
    if (userId) addUserSocket(userId, socket);

    socket.on("user_connected", (uid) => uid && addUserSocket(uid, socket));
    socket.on("user_logout", (uid) => {
      if (uid) removeUserSocket(uid, socket.id);
      socket.disconnect(true);
    });
    socket.on("disconnect", () => {
      for (const uid of Object.keys(connectedUsers)) removeUserSocket(uid, socket.id);
    });

    console.log("New socket connected:", socket.id);
  });

  redisSub.subscribe("socket_broadcast", (err) => {
    if (err) console.error("Redis subscribe error:", err);
  });
  redisSub.on("message", (channel, message) => {
    const { userId, event, payload } = JSON.parse(message);
    notifyUser(userId, event, payload);
  });
};

const addUserSocket = async (userId, socket) => {
  const uid = String(userId);
  if (!connectedUsers[uid]) connectedUsers[uid] = [];
  if (connectedUsers[uid].some((s) => s.id === socket.id)) return;
  connectedUsers[uid].push(socket);
  console.log("User connected:", uid);

  // Resolve tenant-aware Notification model via dbName in handshake
  let NotificationModel = NotificationLegacy;
  const { dbName } = socket.handshake.auth;
  if (dbName) {
    try {
      const tenantConn = await getTenantDB(dbName);
      NotificationModel = getTenantModels(tenantConn).Notification;
    } catch (e) {
      console.warn("Socket: could not resolve tenant DB for notifications:", e.message);
    }
  }

  const unread = await NotificationModel.find({ userId: uid, read: false }).sort({ createdAt: 1 });
  unread.forEach((n) =>
    socket.emit("new_notification", {
      _id: n._id, text: n.text, type: n.type,
      meta: n.meta, profileImage: n.profileImage, createdAt: n.createdAt,
    })
  );

  if (offlineMessages[userId]?.length) {
    offlineMessages[userId].forEach((msg) => socket.emit(msg.event, msg.payload));
    delete offlineMessages[userId];
  }
};

const removeUserSocket = (userId, socketId) => {
  if (!connectedUsers[userId]) return;
  connectedUsers[userId] = connectedUsers[userId].filter((s) => s.id !== socketId);
  if (!connectedUsers[userId].length) {
    delete connectedUsers[userId];
    console.log("User removed completely:", userId);
  }
};

export const notifyUser = (userId, event, payload) => {
  const uid = String(userId);
  const sockets = connectedUsers[uid];
  if (!sockets?.length) {
    if (!offlineMessages[uid]) offlineMessages[uid] = [];
    offlineMessages[uid].push({ event, payload });
    console.log("🕓 User offline, queued event:", event, "-> User:", uid);
    return;
  }
  sockets.forEach((s) => s.emit(event, payload));
  console.log("Event sent:", event, "-> User:", uid);
};

export const notifyAdmins = (adminIds, event, payload) => {
  adminIds.forEach((id) => {
    redisPub.publish("socket_broadcast", JSON.stringify({ userId: id, event, payload }));
  });
};
