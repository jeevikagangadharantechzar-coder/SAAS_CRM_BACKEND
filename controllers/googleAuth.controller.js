import { google } from "googleapis";
import { getTenantModels } from "../models/tenant/index.js";
import { getTenantDB } from "../config/tenantDB.js";
import UserLegacy from "../models/user.model.js";
import SettingsLegacy from "../models/Settings.js";
import { exchangeCodeForTokens } from "../utils/gmailService.js";
import { setGmailSession } from "../middlewares/gmail.middleware.js";

const oauth2Client = new google.auth.OAuth2(
  process.env.GMEET_CLIENT_ID,
  process.env.GMEET_CLIENT_SECRET
);

const getUser = (req) =>
  req.tenantDB ? getTenantModels(req.tenantDB).User : UserLegacy;

const encodeState = (data) =>
  Buffer.from(JSON.stringify(data)).toString("base64url");

const decodeState = (state) => {
  try {
    return JSON.parse(Buffer.from(state, "base64url").toString());
  } catch {
    // legacy: state was just a plain userId string
    return { id: state, dbName: null, tenantSlug: null };
  }
};

const googleAuthController = {
  authenticate: (req, res) => {
    try {
      const host = req.get("host");
      oauth2Client.redirectUri =
        host.includes("localhost") || host.includes("127.0.0.1")
          ? process.env.GOOGLE_AUTH_REDIRECT_URI
          : process.env.GOOGLE_AUTH_LIVE_REDIRECT_URI;

      // Encode userId + dbName + tenantSlug so callback saves to correct tenant DB
      const dbName = req.tenant?.dbName || null;
      const tenantSlug = req.tenant?.slug || req.params?.tenantSlug || null;
      const state = encodeState({ id: req.user.id, dbName, tenantSlug });

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: [
          "https://www.googleapis.com/auth/calendar.events",
        ],
        state,
      });
      res.json({ success: true, authUrl });
    } catch (err) {
      console.error("Google auth init error:", err);
      res.status(500).json({ success: false });
    }
  },

  callback: async (req, res) => {
    const host = req.get("host");
    const isLocal = host.includes("localhost") || host.includes("127.0.0.1");
    const frontendUrl = isLocal
      ? process.env.FRONTEND_URL_LOCAL
      : process.env.FRONTEND_URL_LIVE;
    const redirectUri = isLocal
      ? process.env.GOOGLE_AUTH_REDIRECT_URI
      : process.env.GOOGLE_AUTH_LIVE_REDIRECT_URI;

    const { code, state, error } = req.query;

    // This one callback URL is shared by three different "Connect Google" flows
    // (Calendar/Meet, Gmail inbox, invoice-sending Gmail) since Google only
    // redirects to pre-registered URIs. Each flow encodes its own purpose in
    // `state` when it kicks off; branch on that here.
    let statePayload = null;
    try { statePayload = JSON.parse(Buffer.from(state, "base64url").toString()); } catch { /* not JSON — legacy plain userId state, handled below */ }
    const purpose = statePayload?.purpose;

    if (error) {
      if (purpose === "invoice" || purpose === "gmail-inbox") {
        const returnPath = purpose === "invoice"
          ? (statePayload.tenantSlug ? `/${statePayload.tenantSlug}/settings` : "/settings")
          : "/emailchat";
        const msg = error === "access_denied" ? "App not verified." : "Authorization failed.";
        return res.redirect(`${frontendUrl}${returnPath}?gmail_error=1&error=${encodeURIComponent(msg)}`);
      }
      return res.redirect(`${frontendUrl}/google-auth?error=denied`);
    }

    if (purpose === "invoice" || purpose === "gmail-inbox") {
      const returnPath = purpose === "invoice"
        ? (statePayload.tenantSlug ? `/${statePayload.tenantSlug}/settings` : "/settings")
        : "/emailchat";
      try {
        const gmailRedirectUri = isLocal ? process.env.GMAIL_REDIRECT_URI : process.env.GMAIL_LIVE_REDIRECT_URI;
        const result = await exchangeCodeForTokens(code, gmailRedirectUri);
        const email = result.email;

        if (purpose === "invoice") {
          let Settings;
          if (statePayload.dbName) {
            const tenantConn = await getTenantDB(statePayload.dbName);
            Settings = getTenantModels(tenantConn).Settings;
          } else {
            Settings = SettingsLegacy;
          }
          let settings = await Settings.findOne();
          if (!settings) settings = new Settings({});
          settings.invoiceSenderEmail = email;
          await settings.save();
        } else {
          setGmailSession(res, email);
        }

        const connectedParam = purpose === "invoice" ? "gmail_invoice_connected" : "gmail_connected";
        return res.redirect(`${frontendUrl}${returnPath}?${connectedParam}=1&email=${encodeURIComponent(email)}`);
      } catch (err) {
        let msg = err.message;
        if (err.message?.includes("invalid_grant")) msg = "Authorization code expired. Please reconnect.";
        return res.redirect(`${frontendUrl}${returnPath}?gmail_error=1&error=${encodeURIComponent(msg)}`);
      }
    }

    try {
      oauth2Client.redirectUri = redirectUri;
      const { tokens } = await oauth2Client.getToken(code);
      oauth2Client.setCredentials(tokens);

      const { id, dbName, tenantSlug } = decodeState(state);

      // Resolve correct User model — tenant or legacy
      let User;
      if (dbName) {
        const tenantConn = await getTenantDB(dbName);
        User = getTenantModels(tenantConn).User;
      } else {
        User = UserLegacy;
      }

      const user = await User.findById(id);
      if (!user) {
        return res.redirect(`${frontendUrl}/google-auth?error=user_not_found`);
      }

      await User.findByIdAndUpdate(id, {
        googleAuth: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token || user.googleAuth?.refreshToken,
          expiryDate: tokens.expiry_date,
          scope: tokens.scope,
          connected: true,
          connectedAt: new Date(),
        },
      });

      // Redirect back to the tenant's meetings page
      const returnPath = tenantSlug ? `/${tenantSlug}/meetings` : "/google-auth";
      res.redirect(`${frontendUrl}${returnPath}?google=connected`);
    } catch (err) {
      console.error("OAuth callback error:", err);
      res.redirect(`${frontendUrl}/google-auth?error=failed`);
    }
  },

  getAuthStatus: async (req, res) => {
    try {
      const User = getUser(req);
      const user = await User.findById(req.user.id);
      if (!user?.googleAuth?.accessToken) {
        return res.json({ success: true, connected: false });
      }

      const isExpired = Date.now() >= user.googleAuth.expiryDate - 300000;
      if (isExpired && user.googleAuth.refreshToken) {
        try {
          oauth2Client.setCredentials({
            refresh_token: user.googleAuth.refreshToken,
          });
          const { credentials } = await oauth2Client.refreshAccessToken();
          await User.findByIdAndUpdate(req.user.id, {
            "googleAuth.accessToken": credentials.access_token,
            "googleAuth.expiryDate": credentials.expiry_date,
          });
          return res.json({ success: true, connected: true });
        } catch {
          await User.findByIdAndUpdate(req.user.id, {
            $unset: { googleAuth: 1 },
          });
          return res.json({ success: true, connected: false });
        }
      }

      res.json({ success: true, connected: true });
    } catch (err) {
      console.error("getAuthStatus error:", err);
      res.status(500).json({ success: false, connected: false });
    }
  },

  disconnect: async (req, res) => {
    try {
      const User = getUser(req);
      await User.findByIdAndUpdate(req.user.id, { $unset: { googleAuth: 1 } });
      res.json({ success: true });
    } catch (err) {
      console.error("disconnect error:", err);
      res.status(500).json({ success: false });
    }
  },
};

export default googleAuthController;
