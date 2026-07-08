import nodemailer from "nodemailer";
import SuperAdminSettings from "../models/master/SuperAdminSettings.js";

function interpolate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    vars[key] !== undefined ? vars[key] : `{{${key}}}`
  );
}

// Beautiful default welcome email — same design as the original hardcoded one
const BEAUTIFUL_WELCOME_BODY = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Welcome to {{platformName}}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="580" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#1a73e8 0%,#0d47a1 100%);padding:36px 40px;text-align:center;">
              {{logoImgTag}}
              <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;letter-spacing:-0.5px;">
                Welcome to {{platformName}}
              </h1>
              <p style="margin:8px 0 0;color:#c8dcff;font-size:14px;">Your workspace is ready</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 40px;">
              <p style="margin:0 0 20px;color:#333;font-size:16px;">Hi <strong>{{adminName}}</strong>,</p>
              <p style="margin:0 0 28px;color:#555;font-size:15px;line-height:1.6;">
                Your CRM account has been created successfully. Below are your login credentials — please keep them safe and change your password after your first login.
              </p>

              <!-- Credentials box -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4ff;border:1px solid #d0dcff;border-radius:8px;margin-bottom:32px;">
                <tr>
                  <td style="padding:24px 28px;">
                    <p style="margin:0 0 14px;font-size:13px;font-weight:600;color:#1a73e8;text-transform:uppercase;letter-spacing:0.8px;">Login Credentials</p>
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding:6px 0;color:#666;font-size:14px;width:90px;">Email</td>
                        <td style="padding:6px 0;color:#111;font-size:14px;font-weight:600;">{{email}}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;color:#666;font-size:14px;">Password</td>
                        <td style="padding:6px 0;">
                          <span style="background:#fff;border:1px solid #d0dcff;border-radius:4px;padding:4px 12px;font-family:monospace;font-size:15px;color:#1a73e8;font-weight:700;letter-spacing:1px;">{{password}}</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding-bottom:28px;">
                    <a href="{{loginUrl}}" target="_blank"
                       style="display:inline-block;background:linear-gradient(135deg,#1a73e8 0%,#0d47a1 100%);color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;padding:16px 44px;border-radius:8px;letter-spacing:0.3px;box-shadow:0 4px 12px rgba(26,115,232,0.35);">
                      Login to Dashboard →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0;color:#888;font-size:13px;line-height:1.6;border-top:1px solid #eee;padding-top:20px;">
                For security, please change your password immediately after logging in.<br/>
                If you did not request this account, please contact your administrator.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f9fafc;padding:20px 40px;text-align:center;border-top:1px solid #eee;">
              <p style="margin:0;color:#aaa;font-size:12px;">© {{year}} {{platformName}}. All rights reserved.</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

async function getTransporter() {
  let settings = null;
  try {
    settings = await SuperAdminSettings.findOne();
  } catch (_) {}

  if (settings?.smtpHost && settings?.smtpUser && settings?.smtpPass) {
    return nodemailer.createTransport({
      host: settings.smtpHost,
      port: settings.smtpPort || 587,
      secure: settings.smtpSecure || false,
      auth: { user: settings.smtpUser, pass: settings.smtpPass },
    });
  }

  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
}

async function getFromAddress(settings) {
  const fromName =
    settings?.smtpFromName || settings?.platformName || "TZI Support";
  const fromEmail =
    (settings?.smtpHost ? settings?.smtpUser : null) || process.env.EMAIL_USER;
  return `"${fromName}" <${fromEmail}>`;
}

// Detect old plain-text default body so we can upgrade it automatically
function isOldPlainBody(body) {
  return !body || body.trim().startsWith("<p>Hi {{adminName}},</p>");
}

/**
 * Send welcome email to a new tenant admin.
 * vars: { adminName, email, password, loginUrl }
 */
export async function sendWelcomeEmail({ to, vars }) {
  let settings = null;
  try {
    settings = await SuperAdminSettings.findOne();
  } catch (_) {}

  const platformName = settings?.platformName || "TZI CRM SaaS Platform";
  const backendUrl = process.env.BACKEND_URL || "http://localhost:5000";
  const logoImgTag = settings?.platformLogo
    ? `<img src="${backendUrl}/${settings.platformLogo}" alt="${platformName}" style="height:48px;width:auto;object-fit:contain;margin:0 auto 16px;display:block;" />`
    : "";
  const allVars = { ...vars, platformName, year: new Date().getFullYear(), logoImgTag };

  const subject = interpolate(
    settings?.welcomeSubject ||
      "Welcome to {{platformName}} — Your Login Credentials",
    allVars
  );

  const bodyTemplate = isOldPlainBody(settings?.welcomeBody)
    ? BEAUTIFUL_WELCOME_BODY
    : settings.welcomeBody;

  const html = interpolate(bodyTemplate, allVars);

  const transporter = await getTransporter();
  const from = await getFromAddress(settings);

  await transporter.sendMail({ from, to, subject, html });
}

/**
 * Send upgrade-request alert to super admin.
 * vars: { tenantName, tenantEmail, planName }
 */
export async function sendUpgradeAlertEmail({ vars }) {
  let settings = null;
  try {
    settings = await SuperAdminSettings.findOne();
  } catch (_) {}

  if (settings && settings.upgradeAlertEnabled === false) return;

  const to =
    settings?.upgradeAlertEmail ||
    settings?.supportEmail ||
    process.env.EMAIL_USER;

  if (!to) return;

  const platformName = settings?.platformName || "TZI CRM SaaS Platform";
  const allVars = { ...vars, platformName };

  const subject = interpolate(
    "Upgrade Request — {{tenantName}} wants to upgrade to {{planName}}",
    allVars
  );
  const html = interpolate(
    `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:40px 0;">
    <tr><td align="center">
      <table width="540" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:linear-gradient(135deg,#f59e0b 0%,#d97706 100%);padding:28px 36px;text-align:center;">
            <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;">Plan Upgrade Request</h1>
            <p style="margin:6px 0 0;color:#fef3c7;font-size:14px;">A tenant is requesting an upgrade</p>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 36px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;margin-bottom:24px;">
              <tr><td style="padding:20px 24px;">
                <p style="margin:0 0 10px;font-size:12px;font-weight:600;color:#d97706;text-transform:uppercase;letter-spacing:0.8px;">Request Details</p>
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding:5px 0;color:#666;font-size:14px;width:110px;">Tenant</td>
                    <td style="padding:5px 0;color:#111;font-size:14px;font-weight:600;">{{tenantName}}</td>
                  </tr>
                  <tr>
                    <td style="padding:5px 0;color:#666;font-size:14px;">Email</td>
                    <td style="padding:5px 0;color:#111;font-size:14px;">{{tenantEmail}}</td>
                  </tr>
                  <tr>
                    <td style="padding:5px 0;color:#666;font-size:14px;">Plan</td>
                    <td style="padding:5px 0;color:#111;font-size:14px;font-weight:600;">{{planName}}</td>
                  </tr>
                </table>
              </td></tr>
            </table>
            <p style="margin:0;color:#888;font-size:13px;">Log in to the {{platformName}} super admin panel to review and approve this request.</p>
          </td>
        </tr>
        <tr>
          <td style="background:#f9fafc;padding:16px 36px;text-align:center;border-top:1px solid #eee;">
            <p style="margin:0;color:#aaa;font-size:12px;">{{platformName}} — Super Admin Notification</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
    allVars
  );

  const transporter = await getTransporter();
  const from = await getFromAddress(settings);

  await transporter.sendMail({ from, to, subject, html });
}

// Default plan email template — uses {{priceLabel}} and {{description}} as pre-built vars
const BEAUTIFUL_PLAN_BODY = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:40px 0;">
    <tr><td align="center">
      <table width="580" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:linear-gradient(135deg,#059669 0%,#047857 100%);padding:36px 40px;text-align:center;">
            <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;letter-spacing:-0.5px;">Plan Activated</h1>
            <p style="margin:8px 0 0;color:#a7f3d0;font-size:14px;">Your subscription is now live on {{platformName}}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 40px;">
            <p style="margin:0 0 20px;color:#333;font-size:16px;">Hi <strong>{{adminName}}</strong>,</p>
            <p style="margin:0 0 28px;color:#555;font-size:15px;line-height:1.6;">Your workspace has been set up with the plan details below. Here is a summary of your subscription.</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;margin-bottom:32px;">
              <tr><td style="padding:24px 28px;">
                <p style="margin:0 0 16px;font-size:13px;font-weight:600;color:#059669;text-transform:uppercase;letter-spacing:0.8px;">Subscription Details</p>
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding:7px 0;color:#666;font-size:14px;width:130px;">Plan Name</td>
                    <td style="padding:7px 0;color:#111;font-size:14px;font-weight:600;">{{planName}}</td>
                  </tr>
                  <tr>
                    <td style="padding:7px 0;color:#666;font-size:14px;">Plan Type</td>
                    <td style="padding:7px 0;"><span style="background:#d1fae5;color:#065f46;font-size:12px;font-weight:700;padding:3px 10px;border-radius:20px;text-transform:uppercase;">{{planType}}</span></td>
                  </tr>
                  <tr>
                    <td style="padding:7px 0;color:#666;font-size:14px;">Price</td>
                    <td style="padding:7px 0;color:#111;font-size:14px;font-weight:600;">{{priceLabel}}</td>
                  </tr>
                  <tr>
                    <td style="padding:7px 0;color:#666;font-size:14px;">Max Users</td>
                    <td style="padding:7px 0;color:#111;font-size:14px;font-weight:600;">{{maxUsers}}</td>
                  </tr>
                  <tr>
                    <td style="padding:7px 0;color:#666;font-size:14px;">Start Date</td>
                    <td style="padding:7px 0;color:#111;font-size:14px;font-weight:600;">{{startDate}}</td>
                  </tr>
                  <tr>
                    <td style="padding:7px 0;color:#666;font-size:14px;">End Date</td>
                    <td style="padding:7px 0;color:#111;font-size:14px;font-weight:600;">{{endDate}}</td>
                  </tr>
                </table>
                {{description}}
              </td></tr>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr><td align="center" style="padding-bottom:28px;">
                <a href="{{loginUrl}}" target="_blank" style="display:inline-block;background:linear-gradient(135deg,#059669 0%,#047857 100%);color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;padding:16px 44px;border-radius:8px;letter-spacing:0.3px;box-shadow:0 4px 12px rgba(5,150,105,0.35);">Go to Dashboard →</a>
              </td></tr>
            </table>
            <p style="margin:0;color:#888;font-size:13px;line-height:1.6;border-top:1px solid #eee;padding-top:20px;">If you have any questions about your plan, contact your platform administrator.</p>
          </td>
        </tr>
        <tr>
          <td style="background:#f9fafc;padding:20px 40px;text-align:center;border-top:1px solid #eee;">
            <p style="margin:0;color:#aaa;font-size:12px;">© {{year}} {{platformName}}. All rights reserved.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

// Hardcoded trial email — not editable via settings (no plan info to show)
const BEAUTIFUL_TRIAL_BODY = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:40px 0;">
    <tr><td align="center">
      <table width="580" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:linear-gradient(135deg,#7c3aed 0%,#4f46e5 100%);padding:36px 40px;text-align:center;">
            <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;letter-spacing:-0.5px;">Your Free Trial is Active</h1>
            <p style="margin:8px 0 0;color:#ddd6fe;font-size:14px;">Explore {{platformName}} with full access</p>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 40px;">
            <p style="margin:0 0 20px;color:#333;font-size:16px;">Hi <strong>{{adminName}}</strong>,</p>
            <p style="margin:0 0 28px;color:#555;font-size:15px;line-height:1.6;">Your workspace has been set up on a <strong>Free Trial</strong>. You now have access to explore the platform and all its features.</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f3ff;border:1px solid #ddd6fe;border-radius:8px;margin-bottom:32px;">
              <tr><td style="padding:24px 28px;">
                <p style="margin:0 0 16px;font-size:13px;font-weight:600;color:#7c3aed;text-transform:uppercase;letter-spacing:0.8px;">Trial Plan Details</p>
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding:7px 0;color:#666;font-size:14px;width:130px;">Plan</td>
                    <td style="padding:7px 0;"><span style="background:#ede9fe;color:#6d28d9;font-size:12px;font-weight:700;padding:3px 10px;border-radius:20px;text-transform:uppercase;">Free Trial</span></td>
                  </tr>
                  <tr>
                    <td style="padding:7px 0;color:#666;font-size:14px;">Cost</td>
                    <td style="padding:7px 0;color:#111;font-size:14px;font-weight:600;">Free</td>
                  </tr>
                  <tr>
                    <td style="padding:7px 0;color:#666;font-size:14px;">Status</td>
                    <td style="padding:7px 0;color:#111;font-size:14px;font-weight:600;">Active</td>
                  </tr>
                </table>
              </td></tr>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr><td align="center" style="padding-bottom:28px;">
                <a href="{{loginUrl}}" target="_blank" style="display:inline-block;background:linear-gradient(135deg,#7c3aed 0%,#4f46e5 100%);color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;padding:16px 44px;border-radius:8px;letter-spacing:0.3px;box-shadow:0 4px 12px rgba(124,58,237,0.35);">Go to Dashboard →</a>
              </td></tr>
            </table>
            <p style="margin:0;color:#888;font-size:13px;line-height:1.6;border-top:1px solid #eee;padding-top:20px;">Ready to unlock more? Contact your platform administrator to upgrade to a paid plan.</p>
          </td>
        </tr>
        <tr>
          <td style="background:#f9fafc;padding:20px 40px;text-align:center;border-top:1px solid #eee;">
            <p style="margin:0;color:#aaa;font-size:12px;">© {{year}} {{platformName}}. All rights reserved.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

/**
 * Send plan details or trial info email to a new tenant admin.
 * vars (plan):  { adminName, planName, planType, price, currency, billingCycle, maxUsers, description, loginUrl }
 * vars (trial): { adminName, loginUrl, isTrial: true }
 */
export async function sendPlanEmail({ to, vars }) {
  let settings = null;
  try {
    settings = await SuperAdminSettings.findOne();
  } catch (_) {}

  const platformName = settings?.platformName || "TZI CRM SaaS Platform";

  let subject, html;

  if (vars.isTrial) {
    subject = `Your Free Trial on ${platformName} has started`;
    const allVars = { ...vars, platformName, year: new Date().getFullYear() };
    html = interpolate(BEAUTIFUL_TRIAL_BODY, allVars);
  } else {
    const priceLabel = Number(vars.price) === 0
      ? "Free"
      : `${vars.currency || "USD"} ${vars.price} / ${vars.billingCycle || "month"}`;
    const descriptionHtml = vars.description
      ? `<p style="margin:16px 0 0;color:#555;font-size:13px;line-height:1.6;border-top:1px solid #a7f3d0;padding-top:14px;">${vars.description}</p>`
      : "";

    const allVars = {
      ...vars,
      platformName,
      year: new Date().getFullYear(),
      priceLabel,
      description: descriptionHtml,
    };

    const subjectTemplate = settings?.planSubject || "Your {{planName}} Plan on {{platformName}}";
    subject = interpolate(subjectTemplate, allVars);

    const storedPlan = settings?.planBody?.trim();
    const bodyTemplate = (storedPlan && storedPlan.includes("{{startDate}}"))
      ? storedPlan
      : BEAUTIFUL_PLAN_BODY;
    html = interpolate(bodyTemplate, allVars);
  }

  const transporter = await getTransporter();
  const from = await getFromAddress(settings);
  await transporter.sendMail({ from, to, subject, html });
}

export { BEAUTIFUL_WELCOME_BODY, BEAUTIFUL_PLAN_BODY };
