import SuperAdminRole from "../models/master/SuperAdminRole.js";
import SuperAdmin from "../models/master/SuperAdmin.js";

export const listSuperAdminRoles = async (req, res) => {
  try {
    const roles = await SuperAdminRole.find().sort({ createdAt: -1 });
    res.json({ success: true, roles });
  } catch (err) {
    console.error("List super admin roles error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

export const getSuperAdminRoleById = async (req, res) => {
  try {
    const role = await SuperAdminRole.findById(req.params.id);
    if (!role) return res.status(404).json({ success: false, error: "Role not found" });
    res.json({ success: true, role });
  } catch (err) {
    console.error("Get super admin role error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

export const createSuperAdminRole = async (req, res) => {
  try {
    const { name, description, permissions } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ success: false, error: "Role name is required" });
    }

    const existing = await SuperAdminRole.findOne({ name: name.trim() });
    if (existing) {
      return res.status(409).json({ success: false, error: "A role with this name already exists" });
    }

    const role = await SuperAdminRole.create({
      name: name.trim(),
      description: description || "",
      permissions: permissions || {},
    });

    res.status(201).json({ success: true, role, message: "Role created successfully" });
  } catch (err) {
    console.error("Create super admin role error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

export const updateSuperAdminRole = async (req, res) => {
  try {
    const { name, description, permissions } = req.body;
    const role = await SuperAdminRole.findById(req.params.id);
    if (!role) return res.status(404).json({ success: false, error: "Role not found" });

    if (name?.trim() && name.trim() !== role.name) {
      // Renaming it away would let a delete/permission guard elsewhere miss
      // it entirely, defeating the protection those checks rely on.
      if (role.name.toLowerCase() === "owner") {
        return res.status(400).json({ success: false, error: "The Owner role cannot be renamed." });
      }

      const existing = await SuperAdminRole.findOne({ name: name.trim(), _id: { $ne: role._id } });
      if (existing) {
        return res.status(409).json({ success: false, error: "A role with this name already exists" });
      }
      role.name = name.trim();
    }

    if (description !== undefined) role.description = description;

    if (permissions) {
      const mergedPermissions = { ...role.permissions.toObject(), ...permissions };

      // Never allow the last role with admin_users access to lose it — that
      // would permanently lock every super admin out of Users & Roles, with
      // no account left able to grant it back.
      if (role.permissions.admin_users && !mergedPermissions.admin_users) {
        const otherRoleWithAccess = await SuperAdminRole.countDocuments({
          _id: { $ne: role._id },
          "permissions.admin_users": true,
        });
        if (otherRoleWithAccess === 0) {
          return res.status(400).json({
            success: false,
            error: "Cannot remove Users & Roles access from this role — it is the only role with that permission. Grant it to another role first.",
          });
        }
      }

      role.permissions = mergedPermissions;
    }

    await role.save();
    res.json({ success: true, role, message: "Role updated successfully" });
  } catch (err) {
    console.error("Update super admin role error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

export const deleteSuperAdminRole = async (req, res) => {
  try {
    const role = await SuperAdminRole.findById(req.params.id);
    if (!role) return res.status(404).json({ success: false, error: "Role not found" });

    // The Owner role is the platform's one guaranteed full-access role — it
    // must always exist so there is never a moment with zero roles able to
    // manage Users & Roles, regardless of whether it's currently assigned.
    if (role.name.toLowerCase() === "owner") {
      return res.status(400).json({ success: false, error: "The Owner role cannot be deleted." });
    }

    const assignedCount = await SuperAdmin.countDocuments({ role: role._id });
    if (assignedCount > 0) {
      return res.status(400).json({
        success: false,
        error: `Cannot delete role. ${assignedCount} super admin${assignedCount === 1 ? " is" : "s are"} currently assigned to it.`,
      });
    }

    await SuperAdminRole.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Role deleted successfully" });
  } catch (err) {
    console.error("Delete super admin role error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};
