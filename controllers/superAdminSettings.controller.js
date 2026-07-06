import SuperAdminSettings from "../models/master/SuperAdminSettings.js";
import { BEAUTIFUL_WELCOME_BODY, BEAUTIFUL_PLAN_BODY } from "../utils/dynamicEmail.js";

// Always work with the single settings document; auto-migrate old plain body
async function getOrCreate() {
  let settings = await SuperAdminSettings.findOne();
  if (!settings) {
    settings = await SuperAdminSettings.create({
      welcomeBody: BEAUTIFUL_WELCOME_BODY,
      planBody: BEAUTIFUL_PLAN_BODY,
    });
  } else {
    let dirty = false;

    const isOldPlain = !settings.welcomeBody || settings.welcomeBody.trim().startsWith("<p>Hi {{adminName}},</p>");
    const isDefaultMissingLogo =
      settings.welcomeBody.includes("© {{year}} {{platformName}}") &&
      !settings.welcomeBody.includes("{{logoImgTag}}");
    if (isOldPlain || isDefaultMissingLogo) {
      settings.welcomeBody = BEAUTIFUL_WELCOME_BODY;
      dirty = true;
    }

    // Migrate plan body if it's missing the date fields
    if (!settings.planBody || !settings.planBody.includes("{{startDate}}")) {
      settings.planBody = BEAUTIFUL_PLAN_BODY;
      dirty = true;
    }

    if (dirty) await settings.save();
  }
  return settings;
}

// Public — no auth — returns only branding fields (used by login page)
export const getPublicBranding = async (req, res) => {
  try {
    const settings = await SuperAdminSettings.findOne().select("platformName platformLogo");
    res.json({
      platformName: settings?.platformName || "",
      platformLogo: settings?.platformLogo || "",
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getSettings = async (req, res) => {
  try {
    const settings = await getOrCreate();
    // Never expose raw SMTP password
    const safe = settings.toObject();
    if (safe.smtpPass) safe.smtpPass = "********";
    res.json(safe);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const updateSettings = async (req, res) => {
  try {
    const allowed = [
      "platformName",
      "platformLogo",
      "supportEmail",
      "smtpHost",
      "smtpPort",
      "smtpUser",
      "smtpSecure",
      "smtpFromName",
      "welcomeSubject",
      "welcomeBody",
      "planSubject",
      "planBody",
      "upgradeAlertEnabled",
      "upgradeAlertEmail",
    ];

    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    // Only update smtpPass if a real value is supplied (not the masked placeholder)
    if (req.body.smtpPass && req.body.smtpPass !== "********") {
      updates.smtpPass = req.body.smtpPass;
    }

    const settings = await SuperAdminSettings.findOneAndUpdate(
      {},
      { $set: updates },
      { new: true, upsert: true }
    );

    const safe = settings.toObject();
    if (safe.smtpPass) safe.smtpPass = "********";
    res.json({ message: "Settings updated", settings: safe });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const uploadPlatformLogo = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    const logoPath = req.file.path.replace(/\\/g, "/");
    const settings = await SuperAdminSettings.findOneAndUpdate(
      {},
      { $set: { platformLogo: logoPath } },
      { new: true, upsert: true }
    );

    res.json({ message: "Logo uploaded", logoPath: settings.platformLogo });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
