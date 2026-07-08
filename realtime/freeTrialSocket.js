// Dedicated Socket.IO namespace for free-trial expiry events (7/3/1-day
// reminders + final expiry notice) — kept separate from the generic
// notification socket in realtime/socket.js so trial traffic has its own
// channel/room, mirroring the pattern used by realtime/targetSocket.js.
import Redis from "ioredis";

const redisConfig = {
  host: "127.0.0.1",
  port: 6379,
  enableOfflineQueue: true,
  retryStrategy: (times) => Math.min(times * 50, 2000),
};

const redisPub = new Redis(redisConfig);
const redisSub = new Redis(redisConfig);

redisPub.on("error", (err) => console.warn("FreeTrial Redis pub:", err.message));
redisSub.on("error", (err) => console.warn("FreeTrial Redis sub:", err.message));

export const connectedTrialUsers = {};
const offlineTrialMessages = {};

let trialNsp = null;

const addUserSocket = (userId, socket) => {
  const uid = String(userId);
  if (!connectedTrialUsers[uid]) connectedTrialUsers[uid] = [];
  if (connectedTrialUsers[uid].some((s) => s.id === socket.id)) return;
  connectedTrialUsers[uid].push(socket);

  if (offlineTrialMessages[uid]) {
    // Only one queued message per event type (see queueOffline below), so this
    // replays at most the latest reminder + the latest expired notice — never
    // a backlog of stale test-edit events from earlier DB date changes.
    Object.values(offlineTrialMessages[uid]).forEach((msg) => socket.emit(msg.event, msg.payload));
    delete offlineTrialMessages[uid];
  }
};

const queueOffline = (uid, event, payload) => {
  if (!offlineTrialMessages[uid]) offlineTrialMessages[uid] = {};
  // Keyed by event name so a later trial_reminder (e.g. re-tested with a new
  // date) replaces an earlier queued one instead of piling up and replaying
  // out-of-date info alongside it on reconnect.
  offlineTrialMessages[uid][event] = { event, payload };
};

const removeUserSocket = (userId, socketId) => {
  const uid = String(userId);
  if (!connectedTrialUsers[uid]) return;
  connectedTrialUsers[uid] = connectedTrialUsers[uid].filter((s) => s.id !== socketId);
  if (!connectedTrialUsers[uid].length) delete connectedTrialUsers[uid];
};

export const initFreeTrialSocket = (io) => {
  trialNsp = io.of("/free-trial");

  trialNsp.on("connection", (socket) => {
    const { userId } = socket.handshake.auth;
    if (userId) addUserSocket(userId, socket);

    socket.on("user_connected", (uid) => uid && addUserSocket(uid, socket));
    socket.on("disconnect", () => {
      for (const uid of Object.keys(connectedTrialUsers)) removeUserSocket(uid, socket.id);
    });

    console.log("Free-trial socket connected:", socket.id);
  });

  redisSub.subscribe("free_trial_broadcast", (err) => {
    if (err) console.error("FreeTrial Redis subscribe error:", err);
  });
  redisSub.on("message", (channel, message) => {
    if (channel !== "free_trial_broadcast") return;
    try {
      const { userId, event, payload } = JSON.parse(message);
      deliverToUser(userId, event, payload);
    } catch (e) {
      console.error("Free-trial socket broadcast parse error:", e.message);
    }
  });
};

const deliverToUser = (userId, event, payload) => {
  const uid = String(userId);
  const sockets = connectedTrialUsers[uid];
  if (!sockets?.length) {
    queueOffline(uid, event, payload);
    return;
  }
  sockets.forEach((s) => s.emit(event, payload));
};

// Emits directly if the user is connected to this process; otherwise queues offline.
export const notifyTrialUser = (userId, event, payload) => {
  deliverToUser(userId, event, payload);
};

// Cross-process safe broadcast (e.g. when multiple app instances run behind a load balancer).
export const notifyTrialAdmins = (adminIds, event, payload) => {
  adminIds.forEach((id) => {
    redisPub.publish("free_trial_broadcast", JSON.stringify({ userId: id, event, payload }));
  });
};
