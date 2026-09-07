import FreeTrialSignup from "../models/master/FreeTrialSignup.js";
import Tenant from "../models/master/Tenant.js";

export const getFreeTrialAnalysis = async (req, res) => {
  try {
    const signups = await FreeTrialSignup.find().populate(
      "tenant",
      "isActive plan_status plan_end_date slug name adminEmail adminName createdAt source"
    );

    let total = 0;
    let converted = [];
    let expired = [];
    let pending = [];

    const now = new Date();

    signups.forEach((signup) => {
      const tenant = signup.tenant;

      // Exclude deleted or inactive tenants
      if (!tenant || !tenant.isActive) return;

      const mappedRecord = {
        _id: tenant._id,
        name: tenant.adminName,
        email: tenant.adminEmail,
        businessName: tenant.name,
        createdAt: signup.createdAt,
        industry: signup.industry,
        country: signup.country,
        interestedPackage: signup.interestedPackage,
        tenant: tenant,
        origin: "free_trial",
      };

      total++;

      if (tenant.plan_status === "active" || tenant.plan_status === "cancelled") {
        converted.push(mappedRecord);
      } else if (tenant.plan_status === "grace") {
        pending.push(mappedRecord);
      } else if (tenant.plan_status === "expired") {
        expired.push(mappedRecord);
      } else if (tenant.plan_status === "trial") {
        if (tenant.plan_end_date && now > new Date(tenant.plan_end_date)) {
          expired.push(mappedRecord);
        } else {
          pending.push(mappedRecord);
        }
      }
    });

    res.json({
      success: true,
      data: {
        summary: {
          total,
          converted: converted.length,
          expired: expired.length,
          pending: pending.length,
        },
        details: {
          converted,
          expired,
          pending,
        },
      },
    });
  } catch (err) {
    console.error("Free trial analysis error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};
