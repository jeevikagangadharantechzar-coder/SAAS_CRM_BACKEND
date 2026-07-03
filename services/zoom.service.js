import axios from "axios";

const ZOOM_OAUTH_BASE = "https://zoom.us/oauth";
const ZOOM_API_BASE = "https://api.zoom.us/v2";

// Zoom is tenant-specific: each tenant connects their own Zoom account via
// Settings, and their credentials (clientId, clientSecret, accountId,
// hostUserId) are passed in as `config` on every call below — nothing here
// reads from process.env.

const basicAuthHeader = (config) => {
  const credentials = `${config.clientId}:${config.clientSecret}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
};

export const isZoomConfigured = (config) =>
  Boolean(config?.clientId && config?.clientSecret && config?.accountId && config?.hostUserId);

// Zoom's OAuth token endpoint returns errors as { error, reason }, while its
// REST API (meetings, users, ...) returns them as { code, message }. Normalize
// both shapes into a single readable Error so callers don't need to know which
// endpoint failed.
const wrapZoomError = (err, fallback) => {
  const data = err.response?.data;
  const detail = data?.reason || data?.message || err.message || fallback;
  const wrapped = new Error(detail);
  wrapped.status = err.response?.status;
  wrapped.zoomData = data;
  return wrapped;
};

// Server-to-Server OAuth has no refresh token — you just request a fresh
// access token via the account_credentials grant whenever needed. Cached
// in-memory per tenant (keyed by accountId) so we're not minting a new token
// on every meeting API call.
const tokenCache = new Map();

const getAccessToken = async (config) => {
  const cached = tokenCache.get(config.accountId);
  if (cached && Date.now() < cached.expiry - 60000) {
    return cached.token;
  }

  try {
    const { data } = await axios.post(`${ZOOM_OAUTH_BASE}/token`, null, {
      params: {
        grant_type: "account_credentials",
        account_id: config.accountId,
      },
      headers: { Authorization: basicAuthHeader(config) },
    });

    tokenCache.set(config.accountId, {
      token: data.access_token,
      expiry: Date.now() + data.expires_in * 1000,
    });
    return data.access_token;
  } catch (err) {
    throw wrapZoomError(err, "Failed to authenticate with Zoom");
  }
};

export const createZoomMeeting = async (config, { title, description, startDateTime, endDateTime }) => {
  const accessToken = await getAccessToken(config);
  const durationMinutes = Math.max(
    1,
    Math.round((new Date(endDateTime) - new Date(startDateTime)) / 60000)
  );

  try {
    const { data } = await axios.post(
      `${ZOOM_API_BASE}/users/${encodeURIComponent(config.hostUserId)}/meetings`,
      {
        topic: title,
        agenda: description || "",
        type: 2,
        start_time: new Date(startDateTime).toISOString(),
        duration: durationMinutes,
        settings: {
          join_before_host: true,
          waiting_room: false,
          host_video: true,
          participant_video: true,
          mute_upon_entry: true,
        },
      },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    return data;
  } catch (err) {
    throw wrapZoomError(err, "Failed to create Zoom meeting");
  }
};

export const updateZoomMeeting = async (config, meetingId, patch) => {
  const accessToken = await getAccessToken(config);
  try {
    await axios.patch(`${ZOOM_API_BASE}/meetings/${meetingId}`, patch, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    throw wrapZoomError(err, "Failed to update Zoom meeting");
  }
};

export const deleteZoomMeeting = async (config, meetingId) => {
  const accessToken = await getAccessToken(config);
  try {
    await axios.delete(`${ZOOM_API_BASE}/meetings/${meetingId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    throw wrapZoomError(err, "Failed to delete Zoom meeting");
  }
};
