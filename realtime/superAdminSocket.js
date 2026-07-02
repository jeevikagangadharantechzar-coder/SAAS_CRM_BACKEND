import { io } from "./socket.js";

// Super admin namespace — isolated from tenant user sockets
const SA_NAMESPACE = "/superadmin";
const SA_ROOM = "superadmin-room";

export function initSuperAdminSocket() {
  const nsp = io.of(SA_NAMESPACE);

  nsp.on("connection", (socket) => {
    socket.join(SA_ROOM);
    console.log("Super admin socket connected:", socket.id);

    socket.on("disconnect", () => {
      console.log("Super admin socket disconnected:", socket.id);
    });
  });
}

export function emitToSuperAdmin(event, payload) {
  if (!io) return;
  io.of(SA_NAMESPACE).to(SA_ROOM).emit(event, payload);
}
