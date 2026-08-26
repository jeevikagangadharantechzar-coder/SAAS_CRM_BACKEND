import SoftwareEnquiry from "../models/master/SoftwareEnquiry.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATUS_VALUES = ["New", "Contacted", "Converted", "Rejected"];

// Public — validates the payload coming from the marketing site's
// Software Enquiry form before it is written to the DB.
export const validateSoftwareEnquiry = (req, res, next) => {
  const { name, phone, email, projectType } = req.body;

  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ success: false, error: "Name is required.", code: "VALIDATION_ERROR" });
  }

  if (!phone || typeof phone !== "string" || !phone.trim()) {
    return res.status(400).json({ success: false, error: "Phone number is required.", code: "VALIDATION_ERROR" });
  }

  if (!email || typeof email !== "string" || !EMAIL_REGEX.test(email.trim())) {
    return res.status(400).json({ success: false, error: "A valid email address is required.", code: "VALIDATION_ERROR" });
  }

  if (!projectType || typeof projectType !== "string" || !projectType.trim()) {
    return res.status(400).json({ success: false, error: "Please tell us what you'd like to build.", code: "VALIDATION_ERROR" });
  }

  next();
};

// Public — POST /api/superadmin/software-enquiries/submit
export const submitSoftwareEnquiry = async (req, res) => {
  try {
    const {
      name,
      phone,
      email,
      projectType,
      startTime = "",
      budget = "",
      marketing = "",
    } = req.body;

    const enquiry = await SoftwareEnquiry.create({
      name: name.trim(),
      phone: phone.trim(),
      email: email.toLowerCase().trim(),
      projectType: projectType.trim(),
      startTime: String(startTime || "").trim(),
      budget: String(budget || "").trim(),
      marketing: String(marketing || "").trim(),
    });

    return res.status(201).json({
      success: true,
      message: "Thanks — we'll get back to you within one business day.",
      data: { id: enquiry._id },
    });
  } catch (err) {
    console.error("Software enquiry submit error:", err);
    return res.status(500).json({ success: false, error: err.message || "Server error" });
  }
};

// SuperAdmin — GET /api/superadmin/software-enquiries
export const listSoftwareEnquiries = async (req, res) => {
  try {
    const { search = "", period = "", startDate, endDate, status, page = 1, limit = 10 } = req.query;
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.max(parseInt(limit, 10) || 10, 1);

    const filter = {};

    if (search && search.trim()) {
      const regex = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ name: regex }, { email: regex }, { phone: regex }, { projectType: regex }];
    }

    if (status && STATUS_VALUES.includes(status)) {
      filter.status = status;
    }

    const now = new Date();
    if (period === "weekly") {
      filter.createdAt = { $gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) };
    } else if (period === "monthly") {
      filter.createdAt = { $gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) };
    } else if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(`${startDate}T00:00:00.000Z`);
      if (endDate) filter.createdAt.$lte = new Date(`${endDate}T23:59:59.999Z`);
    }

    const [total, enquiries] = await Promise.all([
      SoftwareEnquiry.countDocuments(filter),
      SoftwareEnquiry.find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum),
    ]);

    res.json({
      success: true,
      data: enquiries,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.max(Math.ceil(total / limitNum), 1),
      },
    });
  } catch (err) {
    console.error("List software enquiries error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

// SuperAdmin — GET /api/superadmin/software-enquiries/:id
export const getSoftwareEnquiryDetails = async (req, res) => {
  try {
    const enquiry = await SoftwareEnquiry.findById(req.params.id);
    if (!enquiry) {
      return res.status(404).json({ success: false, error: "Enquiry not found" });
    }
    return res.status(200).json({ success: true, data: enquiry });
  } catch (err) {
    console.error("Get software enquiry details error:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};

// SuperAdmin — PATCH /api/superadmin/software-enquiries/:id/status
export const updateSoftwareEnquiryStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!STATUS_VALUES.includes(status)) {
      return res.status(400).json({ success: false, error: "Invalid status value." });
    }

    const enquiry = await SoftwareEnquiry.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!enquiry) {
      return res.status(404).json({ success: false, error: "Enquiry not found" });
    }
    return res.status(200).json({ success: true, data: enquiry });
  } catch (err) {
    console.error("Update software enquiry status error:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};

// SuperAdmin — DELETE /api/superadmin/software-enquiries/:id
export const deleteSoftwareEnquiry = async (req, res) => {
  try {
    const enquiry = await SoftwareEnquiry.findByIdAndDelete(req.params.id);
    if (!enquiry) {
      return res.status(404).json({ success: false, error: "Enquiry not found" });
    }
    return res.status(200).json({ success: true, message: "Software enquiry deleted successfully" });
  } catch (err) {
    console.error("Delete software enquiry error:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};
