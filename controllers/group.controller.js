import groupSchema from "../models/schemas/groupSchema.js";
import groupMessageSchema from "../models/schemas/groupMessageSchema.js";
import { getTenantModels } from "../models/tenant/index.js";
import { notifyUser } from "../realtime/socket.js";

const getGroupModel = (conn) => {
  try { return conn.model("Group"); }
  catch { return conn.model("Group", groupSchema); }
};

const getGroupMessageModel = (conn) => {
  try { return conn.model("GroupMessage"); }
  catch { return conn.model("GroupMessage", groupMessageSchema); }
};

export const createGroup = async (req, res) => {
  try {
    const { name, description, memberIds, adminIds, onlyAdminsCanMessage } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: "Group name is required" });

    const Group = getGroupModel(req.tenantDB);
    const currentId = req.user._id;

    const members = [...new Set([String(currentId), ...(memberIds || [])])];
    // creator is always admin; merge with chosen admins
    const admins  = [...new Set([String(currentId), ...(adminIds || [])])];

    const group = await Group.create({
      name: name.trim(),
      description: description || "",
      createdBy: currentId,
      members,
      admins,
      onlyAdminsCanMessage: !!onlyAdminsCanMessage,
    });

    // System message: group created
    const GroupMessage = getGroupMessageModel(req.tenantDB);
    const adminName = `${req.user.firstName} ${req.user.lastName}`.trim() || "Admin";
    await GroupMessage.create({
      groupId:    group._id,
      senderId:   currentId,
      senderName: adminName,
      type:       "system",
      message:    `${adminName} created "${group.name}"`,
    });

    // Build a lean payload identical to what getGroups returns per group
    const groupPayload = {
      _id:                 group._id,
      name:                group.name,
      description:         group.description,
      members:             group.members,
      admins:              group.admins,
      memberCount:         group.members.length,
      onlyAdminsCanMessage: group.onlyAdminsCanMessage,
      createdBy:           group.createdBy,
      createdAt:           group.createdAt,
      unreadCount:         1, // system message counts as unread for non-creator
      lastMessage: {
        message:    `${adminName} created "${group.name}"`,
        senderName: adminName,
        createdAt:  group.createdAt,
      },
    };

    // Notify all members except the creator in real-time
    members
      .filter((mId) => String(mId) !== String(currentId))
      .forEach((mId) => notifyUser(String(mId), "group:group_created", groupPayload));

    res.status(201).json({ group });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getGroups = async (req, res) => {
  try {
    const Group = getGroupModel(req.tenantDB);
    const GroupMessage = getGroupMessageModel(req.tenantDB);
    const { User } = getTenantModels(req.tenantDB);
    const currentId = String(req.user._id);

    const groups = await Group.find({ members: req.user._id }).sort({ updatedAt: -1 });

    const result = await Promise.all(
      groups.map(async (g) => {
        const lastMsg = await GroupMessage.findOne({ groupId: g._id, isDeleted: false })
          .sort({ createdAt: -1 });

        const unreadCount = await GroupMessage.countDocuments({
          groupId: g._id,
          isDeleted: false,
          "readBy.userId": { $ne: req.user._id },
          senderId: { $ne: req.user._id },
        });

        const memberDetails = await User.find({ _id: { $in: g.members } })
          .select("firstName lastName profileImage");

        return {
          _id: g._id,
          name: g.name,
          description: g.description,
          avatar: g.avatar,
          createdBy: g.createdBy,
          members: memberDetails.map((m) => ({
            _id: m._id,
            name: `${m.firstName} ${m.lastName}`.trim(),
            profileImage: m.profileImage || null,
          })),
          admins: g.admins,
          memberCount:          g.members.length,
          onlyAdminsCanMessage: g.onlyAdminsCanMessage,
          lastMessage: lastMsg ? {
            message: lastMsg.message,
            fileType: lastMsg.fileType,
            senderName: lastMsg.senderName,
            createdAt: lastMsg.createdAt,
          } : null,
          unreadCount,
        };
      })
    );

    res.json({ groups: result });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getGroupById = async (req, res) => {
  try {
    const Group = getGroupModel(req.tenantDB);
    const { User } = getTenantModels(req.tenantDB);

    const group = await Group.findById(req.params.groupId);
    if (!group) return res.status(404).json({ message: "Group not found" });

    const isMember = group.members.some((m) => String(m) === String(req.user._id));
    if (!isMember) return res.status(403).json({ message: "Not a member" });

    const memberDetails = await User.find({ _id: { $in: group.members } })
      .select("firstName lastName profileImage email");

    res.json({
      group: {
        ...group.toObject(),
        members: memberDetails.map((m) => ({
          _id: m._id,
          name: `${m.firstName} ${m.lastName}`.trim(),
          profileImage: m.profileImage || null,
          email: m.email,
        })),
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const updateGroup = async (req, res) => {
  try {
    const Group = getGroupModel(req.tenantDB);
    const group = await Group.findById(req.params.groupId);
    if (!group) return res.status(404).json({ message: "Group not found" });

    const isAdmin = group.admins.some((a) => String(a) === String(req.user._id));
    if (!isAdmin) return res.status(403).json({ message: "Only admins can update group" });

    const { name, description, onlyAdminsCanMessage } = req.body;
    if (name) group.name = name.trim();
    if (description !== undefined) group.description = description;
    if (onlyAdminsCanMessage !== undefined) group.onlyAdminsCanMessage = !!onlyAdminsCanMessage;
    await group.save();

    res.json({ group });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const addMembers = async (req, res) => {
  try {
    const Group = getGroupModel(req.tenantDB);
    const group = await Group.findById(req.params.groupId);
    if (!group) return res.status(404).json({ message: "Group not found" });

    const isAdmin = group.admins.some((a) => String(a) === String(req.user._id));
    if (!isAdmin) return res.status(403).json({ message: "Only admins can add members" });

    const { memberIds } = req.body;
    const existing = group.members.map(String);
    const toAdd = (memberIds || []).filter((id) => !existing.includes(String(id)));
    group.members.push(...toAdd);
    await group.save();

    res.json({ success: true, addedCount: toAdd.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const removeMember = async (req, res) => {
  try {
    const Group = getGroupModel(req.tenantDB);
    const group = await Group.findById(req.params.groupId);
    if (!group) return res.status(404).json({ message: "Group not found" });

    const isAdmin = group.admins.some((a) => String(a) === String(req.user._id));
    if (!isAdmin) return res.status(403).json({ message: "Only admins can remove members" });

    group.members = group.members.filter((m) => String(m) !== String(req.params.memberId));
    group.admins  = group.admins.filter((a) => String(a) !== String(req.params.memberId));
    await group.save();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const leaveGroup = async (req, res) => {
  try {
    const Group = getGroupModel(req.tenantDB);
    const group = await Group.findById(req.params.groupId);
    if (!group) return res.status(404).json({ message: "Group not found" });

    const currentId = String(req.user._id);
    group.members = group.members.filter((m) => String(m) !== currentId);
    group.admins  = group.admins.filter((a) => String(a) !== currentId);

    // If no members left, delete group
    if (group.members.length === 0) {
      await Group.findByIdAndDelete(group._id);
    } else {
      // If no admins left, make oldest member admin
      if (group.admins.length === 0) group.admins = [group.members[0]];
      await group.save();
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getGroupMessages = async (req, res) => {
  try {
    const Group = getGroupModel(req.tenantDB);
    const GroupMessage = getGroupMessageModel(req.tenantDB);

    const group = await Group.findById(req.params.groupId);
    if (!group) return res.status(404).json({ message: "Group not found" });

    const isMember = group.members.some((m) => String(m) === String(req.user._id));
    if (!isMember) return res.status(403).json({ message: "Not a member" });

    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip  = (page - 1) * limit;

    const messages = await GroupMessage.find({ groupId: req.params.groupId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.json({ messages: messages.reverse(), page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const markGroupRead = async (req, res) => {
  try {
    const Group = getGroupModel(req.tenantDB);
    const GroupMessage = getGroupMessageModel(req.tenantDB);

    const group = await Group.findById(req.params.groupId);
    if (!group) return res.status(404).json({ message: "Group not found" });

    const currentId = req.user._id;
    const now = new Date();

    await GroupMessage.updateMany(
      {
        groupId: req.params.groupId,
        "readBy.userId": { $ne: currentId },
        senderId: { $ne: currentId },
      },
      { $push: { readBy: { userId: currentId, readAt: now } } }
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const deleteGroup = async (req, res) => {
  try {
    const Group = getGroupModel(req.tenantDB);
    const group = await Group.findById(req.params.groupId);
    if (!group) return res.status(404).json({ message: "Group not found" });

    const isAdmin = group.admins.some((a) => String(a) === String(req.user._id));
    if (!isAdmin) return res.status(403).json({ message: "Only admins can delete group" });

    await Group.findByIdAndDelete(req.params.groupId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const clearGroupChat = async (req, res) => {
  try {
    const Group = getGroupModel(req.tenantDB);
    const GroupMessage = getGroupMessageModel(req.tenantDB);

    const group = await Group.findById(req.params.groupId);
    if (!group) return res.status(404).json({ message: "Group not found" });

    const isMember = group.members.some((m) => String(m) === String(req.user._id));
    if (!isMember) return res.status(403).json({ message: "Not a member" });

    await GroupMessage.deleteMany({ groupId: req.params.groupId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
