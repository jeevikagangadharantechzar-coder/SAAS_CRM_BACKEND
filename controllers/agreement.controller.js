import { getTenantModels } from "../models/tenant/index.js";

const AGREEMENT_TYPES = ["privacy_policy", "terms_conditions"];

const acceptAgreement = async (req, res) => {
  try {
    const { agreementType } = req.body;
    if (!AGREEMENT_TYPES.includes(agreementType)) {
      return res.status(400).json({ success: false, message: "Invalid agreement type" });
    }

    const { User, UserAgreement } = getTenantModels(req.tenantDB);

    await UserAgreement.create({
      user: req.user._id,
      agreementType,
      acceptedAt: new Date(),
      ipAddress: req.ip,
    });

    const field = agreementType === "privacy_policy" ? "privacyPolicyAcceptedAt" : "termsAcceptedAt";
    await User.findByIdAndUpdate(req.user._id, { [field]: new Date() });

    const user = await User.findById(req.user._id);
    res.status(200).json({
      success: true,
      needsPrivacyPolicy: !user.privacyPolicyAcceptedAt,
      needsTerms: !user.termsAcceptedAt,
    });
  } catch (error) {
    console.error("Accept agreement error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

export default { acceptAgreement };
