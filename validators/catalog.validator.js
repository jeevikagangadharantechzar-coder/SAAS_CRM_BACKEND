/**
 * Catalog Input Validation Rules
 * Validates Catalog Category and Catalog Item requests before reaching controllers.
 */

export const validateCreateCategory = (req) => {
  const { name, color } = req.body || {};
  if (!name || typeof name !== "string" || !name.trim()) {
    return "Category name is required and must be a valid string.";
  }
  if (name.trim().length > 100) {
    return "Category name cannot exceed 100 characters.";
  }
  if (color && !/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(color)) {
    return "Invalid hex color format (e.g. #22415F).";
  }
  return null;
};

export const validateUpdateCategory = (req) => {
  const { name, color, isActive } = req.body || {};
  if (name !== undefined) {
    if (typeof name !== "string" || !name.trim()) {
      return "Category name cannot be empty.";
    }
    if (name.trim().length > 100) {
      return "Category name cannot exceed 100 characters.";
    }
  }
  if (color && !/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(color)) {
    return "Invalid hex color format (e.g. #22415F).";
  }
  if (isActive !== undefined && typeof isActive !== "boolean") {
    return "isActive must be a boolean value.";
  }
  return null;
};

export const validateCreateCatalogItem = (req) => {
  const { name, type, price, currency } = req.body || {};
  if (!name || typeof name !== "string" || !name.trim()) {
    return "Item name is required and must be a valid string.";
  }
  if (!type || !["Product", "Service"].includes(type)) {
    return "Item type must be either 'Product' or 'Service'.";
  }
  if (price !== undefined && (isNaN(Number(price)) || Number(price) < 0)) {
    return "Price must be a positive number.";
  }
  if (currency && typeof currency !== "string") {
    return "Currency must be a valid string (e.g. INR, USD).";
  }
  return null;
};
