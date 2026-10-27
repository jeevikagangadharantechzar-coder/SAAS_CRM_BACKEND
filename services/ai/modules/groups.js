import groupSchema from "../../../models/schemas/groupSchema.js";
import { thereAre, isAdmin, getTerms, matchesWord, plural, regexOf } from "../helpers.js";

const WORDS = ["group", "groups", "chat", "chats", "team", "teams", "member", "members", "joined", "part"];

// Group isn't registered in getTenantModels, so register it the same way group.controller.js does.
const getGroupModel = (conn) => {
  try { return conn.model("Group"); }
  catch { return conn.model("Group", groupSchema); }
};

export default {
  name: "groups",

  match: ({ lower }) => matchesWord(lower, "groups?|group chats?|chat groups?"),

  handle: async (ctx) => {
    if (!ctx.req.tenantDB) return null;
    const Group = getGroupModel(ctx.req.tenantDB);
    const { User } = ctx.models;

    const allGroups = isAdmin(ctx) && matchesWord(ctx.lower, "all");
    const term = getTerms(ctx, WORDS)[0];
    const query = allGroups ? {} : { members: ctx.userId };
    if (term) query.name = regexOf(term);

    const groups = await Group.find(query).sort({ updatedAt: -1 }).limit(50).lean();

    // Group members are plain ObjectIds (no ref), so resolve names in one lookup.
    const creatorIds = [...new Set(groups.map((g) => String(g.createdBy)))];
    const creators = User && creatorIds.length ? await User.find({ _id: { $in: creatorIds } }).select("firstName lastName").lean() : [];
    const nameOf = Object.fromEntries(creators.map((u) => [String(u._id), `${u.firstName} ${u.lastName}`]));

    return {
      intent: allGroups ? "groups-all" : "groups-mine",
      message: `${allGroups ? thereAre(groups.length) : "You are a member of"} ${plural(groups.length, "group")}${term ? ` matching "${term}"` : ""}.`,
      data: groups.map((g) => ({
        _id: g._id,
        type: "group",
        name: g.name,
        status: (g.admins || []).some((id) => String(id) === String(ctx.userId)) ? "Admin" : "Member",
        detail: `${plural(g.members?.length || 0, "member")}${g.description ? ` · ${g.description.slice(0, 60)}` : ""}`,
        handledBy: nameOf[String(g.createdBy)] || "Unknown",
        createdAt: g.createdAt,
      })),
    };
  },
};
