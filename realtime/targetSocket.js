// Dedicated Socket.IO namespace for Target Management real-time events
// (reminders, due-today warnings, auto-expiry, reassignment) — kept separate
// from the generic notification socket in realtime/socket.js so target traffic
// has its own channel/room and doesn't compete with the general bell feed.
import Redis from "ioredis";

const redisConfig = {
  host: "127.0.0.1",
  port: 6379,
  enableOfflineQueue: true,
  retryStrategy: (times) => Math.min(times * 50, 2000),
};

const redisPub = new Redis(redisConfig);
const redisSub = new Redis(redisConfig);

redisPub.on("error", (err) => console.warn("Target Redis pub:", err.message));
redisSub.on("error", (err) => console.warn("Target Redis sub:", err.message));

export const connectedTargetUsers = {};
const offlineTargetMessages = {};

let targetNsp = null;

const addUserSocket = (userId, socket) => {
  const uid = String(userId);
  if (!connectedTargetUsers[uid]) connectedTargetUsers[uid] = [];
  if (connectedTargetUsers[uid].some((s) => s.id === socket.id)) return;
  connectedTargetUsers[uid].push(socket);

  if (offlineTargetMessages[uid]?.length) {
    offlineTargetMessages[uid].forEach((msg) => socket.emit(msg.event, msg.payload));
    delete offlineTargetMessages[uid];
  }
};

const removeUserSocket = (userId, socketId) => {
  const uid = String(userId);
  if (!connectedTargetUsers[uid]) return;
  connectedTargetUsers[uid] = connectedTargetUsers[uid].filter((s) => s.id !== socketId);
  if (!connectedTargetUsers[uid].length) delete connectedTargetUsers[uid];
};

export const initTargetSocket = (io) => {
  targetNsp = io.of("/target-management");

  targetNsp.on("connection", (socket) => {
    const { userId } = socket.handshake.auth;
    if (userId) addUserSocket(userId, socket);

    socket.on("user_connected", (uid) => uid && addUserSocket(uid, socket));
    socket.on("disconnect", () => {
      for (const uid of Object.keys(connectedTargetUsers)) removeUserSocket(uid, socket.id);
    });

    console.log("Target-management socket connected:", socket.id);
  });

  redisSub.subscribe("target_socket_broadcast", (err) => {
    if (err) console.error("Target Redis subscribe error:", err);
  });
  redisSub.on("message", (channel, message) => {
    if (channel !== "target_socket_broadcast") return;
    try {
      const { userId, event, payload } = JSON.parse(message);
      deliverToUser(userId, event, payload);
    } catch (e) {
      console.error("Target socket broadcast parse error:", e.message);
    }
  });
};

const deliverToUser = (userId, event, payload) => {
  const uid = String(userId);
  const sockets = connectedTargetUsers[uid];
  if (!sockets?.length) {
    if (!offlineTargetMessages[uid]) offlineTargetMessages[uid] = [];
    offlineTargetMessages[uid].push({ event, payload });
    return;
  }
  sockets.forEach((s) => s.emit(event, payload));
};

// Emits directly if the user is connected to this process; otherwise queues offline.
export const notifyTargetUser = (userId, event, payload) => {
  deliverToUser(userId, event, payload);
};

// Cross-process safe broadcast (e.g. when multiple app instances run behind a load balancer).
export const notifyTargetAdmins = (adminIds, event, payload) => {
  adminIds.forEach((id) => {
    redisPub.publish("target_socket_broadcast", JSON.stringify({ userId: id, event, payload }));
  });
};
