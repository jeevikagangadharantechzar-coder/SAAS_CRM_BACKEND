import chatMessageSchema from "../models/schemas/chatMessageSchema.js";
import { getTenantModels } from "../models/tenant/index.js";

const getChatModel = (conn) => {
  try {
    return conn.model("ChatMessage");
  } catch {
    return conn.model("ChatMessage", chatMessageSchema);
  }
};

export const getContacts = async (req, res) => {
  try {
    const { User } = getTenantModels(req.tenantDB);
    const currentUser = req.user;
    const roleName = currentUser.role?.name?.toLowerCase();
    const ChatMessage = getChatModel(req.tenantDB);

    let users;
    if (roleName === "admin") {
      users = await User.find({ _id: { $ne: currentUser._id } })
        .populate("role", "name")
        .select("firstName lastName email profileImage role");
    } else {
      const all = await User.find({ _id: { $ne: currentUser._id } })
        .populate("role", "name")
        .select("firstName lastName email profileImage role");
      users = all.filter((u) => u.role?.name?.toLowerCase() === "admin");
    }

    const contacts = await Promise.all(
      users.map(async (user) => {
        const lastMsg = await ChatMessage.findOne({
          $or: [
            { senderId: currentUser._id, receiverId: user._id },
            { senderId: user._id, receiverId: currentUser._id },
          ],
        }).sort({ createdAt: -1 });

        const unreadCount = await ChatMessage.countDocuments({
          senderId: user._id,
          receiverId: currentUser._id,
          isRead: false,
        });

        return {
          _id: user._id,
          name: `${user.firstName} ${user.lastName}`.trim(),
          email: user.email,
          profileImage: user.profileImage || null,
          role: user.role?.name,
          lastMessage: lastMsg
            ? {
                message: lastMsg.message,
                fileType: lastMsg.fileType,
                fileName: lastMsg.fileName,
                createdAt: lastMsg.createdAt,
                isRead: lastMsg.isRead,
              }
            : null,
          unreadCount,
        };
      })
    );

    res.json({ contacts });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getMessages = async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUser = req.user;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const ChatMessage = getChatModel(req.tenantDB);

    const messages = await ChatMessage.find({
      $or: [
        { senderId: currentUser._id, receiverId: userId },
        { senderId: userId, receiverId: currentUser._id },
      ],
    })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.json({ messages: messages.reverse(), page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const markAsRead = async (req, res) => {
  try {
    const { userId } = req.params;
    const ChatMessage = getChatModel(req.tenantDB);

    await ChatMessage.updateMany(
      { senderId: userId, receiverId: req.user._id, isRead: false },
      { isRead: true, readAt: new Date() }
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getUnreadCount = async (req, res) => {
  try {
    const ChatMessage = getChatModel(req.tenantDB);

    const unreadCount = await ChatMessage.countDocuments({
      receiverId: req.user._id,
      isRead: false,
    });

    res.json({ unreadCount });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getPinnedMessages = async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUser = req.user;
    const ChatMessage = getChatModel(req.tenantDB);

    const pinnedMessages = await ChatMessage.find({
      $or: [
        { senderId: currentUser._id, receiverId: userId },
        { senderId: userId, receiverId: currentUser._id },
      ],
      isPinned: true,
    }).sort({ createdAt: -1 });

    res.json({ pinnedMessages });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const pinMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { isPinned } = req.body;
    const ChatMessage = getChatModel(req.tenantDB);

    await ChatMessage.findByIdAndUpdate(messageId, { isPinned });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const deleteMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const ChatMessage = getChatModel(req.tenantDB);

    const msg = await ChatMessage.findById(messageId);
    if (!msg) return res.status(404).json({ message: "Message not found" });
    if (String(msg.senderId) !== String(req.user._id))
      return res.status(403).json({ message: "Cannot delete others' messages" });

    await ChatMessage.findByIdAndUpdate(messageId, { isDeleted: true, message: "" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const clearChat = async (req, res) => {
  try {
    const { userId } = req.params;
    const ChatMessage = getChatModel(req.tenantDB);

    await ChatMessage.deleteMany({
      $or: [
        { senderId: req.user._id, receiverId: userId },
        { senderId: userId, receiverId: req.user._id },
      ],
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const addReaction = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { emoji } = req.body;
    const ChatMessage = getChatModel(req.tenantDB);

    const msg = await ChatMessage.findById(messageId);
    if (!msg) return res.status(404).json({ message: "Message not found" });

    const userId = req.user._id;
    // Remove existing reaction from this user, then add new one
    msg.reactions = msg.reactions.filter((r) => String(r.userId) !== String(userId));
    if (emoji) msg.reactions.push({ userId, emoji });
    await msg.save();

    res.json({ reactions: msg.reactions });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const uploadChatFile = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    const fileUrl = req.file.path.replace(/\\/g, "/").replace(/^\/+/, "");
    const fileType = req.file.mimetype.startsWith("image/") ? "image" : "document";

    res.json({
      fileUrl,
      fileName: req.file.originalname,
      fileType,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
