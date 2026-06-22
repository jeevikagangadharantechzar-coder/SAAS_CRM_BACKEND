import { getTenantModels } from "../models/tenant/index.js";
import RoleLegacy from "../models/role.model.js";

const getRole = (req) =>
  req.tenantDB ? getTenantModels(req.tenantDB).Role : RoleLegacy;

const roleController = {
  createRole: async (req, res) => {
    try {
      const Role = getRole(req);
      const { name, description, permissions } = req.body;

      const existingRole = await Role.findOne({ name: name.trim() });
      if (existingRole) return res.status(400).json({ message: "Role already exists" });

      const normalizedPermissions = {};
      if (permissions) {
        Object.keys(permissions).forEach((key) => {
          normalizedPermissions[key] = permissions[key] === true || permissions[key] === "true";
        });
      }

      const role = await Role.create({ name: name.trim(), description, permissions: normalizedPermissions });
      res.status(201).json(role);
    } catch (err) {
      console.error("Error creating role:", err);
      res.status(500).json({ message: "Error creating role", error: err.message });
    }
  },

  getRoles: async (req, res) => {
    try {
      const Role = getRole(req);
      const roles = await Role.find().sort({ createdAt: -1 });

      res.status(200).json({
        success: true,
        total: roles.length,
        roles,
      });
    } catch (err) {
      console.error("Error fetching roles:", err);

      res.status(500).json({
        success: false,
        message: "Error fetching roles",
        error: err.message,
      });
    }
  },

  updateRole: async (req, res) => {
    try {
      const Role = getRole(req);
      const { id } = req.params;
      const { name, description, permissions } = req.body;

      const role = await Role.findById(id);
      if (!role) return res.status(404).json({ message: "Role not found" });

      if (name) role.name = name.trim();
      if (description) role.description = description;
      if (permissions) role.permissions = { ...role.permissions.toObject(), ...permissions };

      const updatedRole = await role.save();
      res.status(200).json(updatedRole);
    } catch (err) {
      console.error("Error updating role:", err);
      res.status(500).json({ message: "Error updating role", error: err.message });
    }
  },

  deleteRole: async (req, res) => {
    try {
      const Role = getRole(req);
      const { id } = req.params;
      const deletedRole = await Role.findByIdAndDelete(id);
      if (!deletedRole) return res.status(404).json({ message: "Role not found" });
      res.status(200).json({ message: "Role deleted successfully" });
    } catch (err) {
      console.error("Error deleting role:", err);
      res.status(500).json({ message: "Error deleting role", error: err.message });
    }
  },
};

export default roleController;
