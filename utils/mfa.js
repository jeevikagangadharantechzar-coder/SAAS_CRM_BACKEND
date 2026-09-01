import speakeasy from 'speakeasy';
import qrcode from 'qrcode';

/**
 * Generate a new MFA secret and a QR code URL.
 * @param {string} email - User email for labeling in Authenticator App
 * @param {string} issuer - App name (e.g., 'TZI CRM')
 * @returns {Promise<{ secret: string, qrCodeDataUrl: string }>}
 */
export const generateMfaRegistration = async (email, issuer = 'TZI CRM') => {
  const secret = speakeasy.generateSecret({
    length: 20,
    name: `${issuer} (${email})`,
    issuer: issuer,
  });

  const qrCodeDataUrl = await qrcode.toDataURL(secret.otpauth_url);

  return {
    secret: secret.base32,
    qrCodeDataUrl,
  };
};

/**
 * Verify an MFA token against a secret.
 * @param {string} secret - The user's stored MFA secret
 * @param {string} token - The 6-digit code provided by the user
 * @returns {boolean} - True if valid, false otherwise
 */
export const verifyMfaToken = (secret, token) => {
  return speakeasy.totp.verify({
    secret: secret,
    encoding: 'base32',
    token: token,
    window: 1 // Allow 1 step (30s) drift
  });
};
