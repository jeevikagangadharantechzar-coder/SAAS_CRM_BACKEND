import { ServiceCatalogService } from "../services/serviceCatalog.service.js";

/**
 * Service Controller:
 * Dedicated exclusively to Services (AMC, Warranty, Installation, Support).
 */

export const getServices = async (req, res) => {
  try {
    const result = await ServiceCatalogService.listServices(req.tenantDB, req.query);
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error("Get services error:", err);
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const getServiceById = async (req, res) => {
  try {
    const service = await ServiceCatalogService.getServiceById(req.tenantDB, req.params.id);
    if (!service) {
      return res.status(404).json({ success: false, message: "Service not found" });
    }
    res.status(200).json({ success: true, service });
  } catch (err) {
    console.error("Get service by ID error:", err);
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const createService = async (req, res) => {
  try {
    const service = await ServiceCatalogService.createService(req.tenantDB, req.user._id, req.body);
    res.status(201).json({ success: true, message: "Service created successfully", service });
  } catch (err) {
    console.error("Create service error:", err);
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: "A service with this SKU already exists" });
    }
    res.status(err.statusCode || 400).json({ success: false, message: err.message });
  }
};

export const updateService = async (req, res) => {
  try {
    const service = await ServiceCatalogService.updateService(req.tenantDB, req.user._id, req.params.id, req.body);
    res.status(200).json({ success: true, message: "Service updated successfully", service });
  } catch (err) {
    console.error("Update service error:", err);
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: "A service with this SKU already exists" });
    }
    res.status(err.statusCode || 400).json({ success: false, message: err.message });
  }
};

export const deleteService = async (req, res) => {
  try {
    const service = await ServiceCatalogService.deleteService(req.tenantDB, req.params.id);
    res.status(200).json({
      success: true,
      message: `Service "${service.name}" deleted successfully`,
    });
  } catch (err) {
    console.error("Delete service error:", err);
    res.status(err.statusCode || 400).json({ success: false, message: err.message });
  }
};
