import { google } from "googleapis";
import { getTenantModels } from "../models/tenant/index.js";
import UserLegacy from "../models/user.model.js";

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);

const getUser = (req) => req.tenantDB ? getTenantModels(req.tenantDB).User : UserLegacy;

const googleAuthController = {
  authenticate: (req, res) => {
    try {
      const host = req.get("host");
      oauth2Client.redirectUri = host.includes("localhost") || host.includes("127.0.0.1")
        ? process.env.GMAIL_REDIRECT_URI
        : process.env.GMAIL_LIVE_REDIRECT_URI;

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: "offline", prompt: "consent",
        scope: ["https://mail.google.com"],
        state: req.user.id,
      });
      res.json({ success: true, authUrl });
    } catch (err) {
      console.error("Google auth init error:", err);
      res.status(500).json({ success: false });
    }
  },

  callback: async (req, res) => {
    try {
      const { code, state, error } = req.query;
      const host = req.get("host");
      let frontendUrl, redirectUri;
      if (host.includes("localhost") || host.includes("127.0.0.1")) {
        frontendUrl = process.env.FRONTEND_URL_LOCAL;
        redirectUri = process.env.GMAIL_REDIRECT_URI;
      } else {
        frontendUrl = process.env.FRONTEND_URL_LIVE;
        redirectUri = process.env.GMAIL_LIVE_REDIRECT_URI;
      }
      oauth2Client.redirectUri = redirectUri;
      if (error) return res.redirect(`${frontendUrl}/google-auth?error=denied`);

      const { tokens } = await oauth2Client.getToken(code);
      oauth2Client.setCredentials(tokens);

      // callback is an OAuth redirect — no req.tenantDB, use legacy
      const user = await UserLegacy.findById(state);
      if (!user) return res.redirect(`${frontendUrl}/google-auth?error=user_not_found`);

      await UserLegacy.findByIdAndUpdate(state, {
        googleAuth: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token || user.googleAuth?.refreshToken,
          expiryDate: tokens.expiry_date,
          scope: tokens.scope,
          connected: true,
          connectedAt: new Date(),
        },
      });
      res.redirect(`${frontendUrl}/google-auth?success=true`);
    } catch (err) {
      console.error("OAuth callback error:", err);
      const host = req.get("host");
      const frontendUrl = host.includes("localhost") || host.includes("127.0.0.1")
        ? (process.env.FRONTEND_URL_LOCAL)
        : (process.env.FRONTEND_URL_LIVE);
      res.redirect(`${frontendUrl}/google-auth?error=failed`);
    }
  },

  getAuthStatus: async (req, res) => {
    const User = getUser(req);
    const user = await User.findById(req.user.id);
    if (!user?.googleAuth?.accessToken) return res.json({ success: true, connected: false });

    const isExpired = Date.now() >= user.googleAuth.expiryDate - 300000;
    if (isExpired && user.googleAuth.refreshToken) {
      try {
        oauth2Client.setCredentials({ refresh_token: user.googleAuth.refreshToken });
        const { credentials } = await oauth2Client.refreshAccessToken();
        await User.findByIdAndUpdate(req.user.id, {
          "googleAuth.accessToken": credentials.access_token,
          "googleAuth.expiryDate": credentials.expiry_date,
        });
        return res.json({ success: true, connected: true });
      } catch (err) {
        await User.findByIdAndUpdate(req.user.id, { $unset: { googleAuth: 1 } });
        return res.json({ success: true, connected: false });
      }
    }
    res.json({ success: true, connected: true });
  },

  disconnect: async (req, res) => {
    const User = getUser(req);
    await User.findByIdAndUpdate(req.user.id, { $unset: { googleAuth: 1 } });
    res.json({ success: true });
  },
};

export default googleAuthController;
