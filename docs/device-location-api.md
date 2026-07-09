# Device Approval & Live Location API — Mobile Integration Guide

Sales accounts are limited to one active session per device type — one web browser, one mobile app.
This document covers the three endpoints the mobile client needs: sign in with a device identity,
wait for approval if a second mobile device is already active, and report location while the app is
in the foreground.

> **Location is not captured at login.** Login only registers which device is signed in. Once
> authenticated, the client is responsible for calling `POST /location/update` on its own interval —
> there is no server-side trigger tied to sign-in.

---

## Contents

- [How the flow works](#how-the-flow-works)
- [Auth & headers](#auth--headers)
- [`POST /users/login`](#post-usersloginlogin)
- [`GET /device-request/:id/status`](#get-device-requestidstatuspoll)
- [`POST /users/logout`](#post-userslogoutlogout)
- [`POST /location/update`](#post-locationupdateloc-update)
- [Error responses](#error-responses)
- [Field glossary](#field-glossary)

---

## How the flow works

Every login sends a device identity. What happens next depends on whether that device's slot (web or
mobile) is already occupied by someone else.

```
1. Sign in                     2. Branch on slot state              3. Poll (if 202)                4. Done
   POST /users/login       →      Slot free  → 200 + token     ┐
   deviceType, deviceId,          Slot taken → 202 + requestId ┘→  GET /device-request/:id/status →  status: "active"
   deviceLabel                                                     every 3–5s                         + token
```

An Admin approves or rejects the request from the CRM web app; the mobile client never talks to an
Admin directly — it only polls. **Approving a new device automatically signs the old one of the same
type out** (its token stops working on its next request).

---

## Auth & headers

Two URL patterns work for every endpoint below. Pick one and use it consistently once signed in.

| Pattern | Example | When to use |
|---|---|---|
| `/{tenantSlug}/api/…` | `POST /acme-co/api/users/login` | Once the tenant slug is known (returned in the login/poll response as `slug`). Use this for every call after sign-in. |
| `/api/…` + `tenantSlug` in body/query | `POST /api/users/login` | Before the tenant slug is known — the app's first-ever sign-in, or after the user picks a workspace. |

All authenticated requests send the token from `login` / the approval poll as a bearer header:

```
Authorization: Bearer <token>
Content-Type: application/json
```

---

## `POST /users/login` {#login}

`/{tenantSlug}/api/users/login` — **no auth required**

Authenticates the user and registers this device against their `mobile` slot. Always send device
fields from mobile — omitting them skips device tracking entirely and the account keeps unlimited
concurrent sessions, which defeats the feature.

### Request body

| Field | Type | Notes |
|---|---|---|
| `email` **required** | string | Account email. |
| `password` **required** | string | Account password. |
| `tenantSlug` *optional* | string | Required only when calling the unified `/api/users/login` path (see Auth & headers above). |
| `deviceType` **required** | `"mobile"` | Always the literal string `"mobile"` from the app. |
| `deviceId` **required** | string | Stable per-install identifier. Generate once, persist it (Keychain / EncryptedSharedPreferences), reuse on every login — a fresh id looks like a new device and can trigger an approval request unnecessarily. |
| `deviceLabel` *optional* | string | Human-readable, shown to the Admin approving the request — e.g. `"iPhone 15 Pro"` or `"Pixel 8"`. |

```json
{
  "email": "rep@acme.co",
  "password": "••••••••",
  "tenantSlug": "acme-co",
  "deviceType": "mobile",
  "deviceId": "3F2A9E1C-...-B4D2",
  "deviceLabel": "iPhone 15 Pro"
}
```

### `200` — Signed in

Slot was free, or this exact device was already the active one.

```json
{
  "success": true,
  "message": "Login successful",
  "_id": "665f1a2b3c4d5e6f7a8b9c0d",
  "name": "Jane Rep",
  "email": "rep@acme.co",
  "profileImage": null,
  "role": { "_id": "...", "name": "Sales", "permissions": { "...": "..." } },
  "slug": "acme-co",
  "isDbRefreshed": false,
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

Store `token` and `slug`. Every request from here on uses `Authorization: Bearer <token>` and the
`/{slug}/api/…` URL pattern.

### `202` — Waiting on approval

A different mobile device is already signed in.

```json
{
  "success": false,
  "requiresApproval": true,
  "requestId": "665f9c1e3c4d5e6f7a8b9c22",
  "message": "You're already logged in on another mobile. Waiting for admin approval to continue here."
}
```

No token yet. Show a waiting state and start polling `requestId` against the endpoint below.

### Other responses

| Status | Meaning |
|---|---|
| `401` | Bad credentials |
| `403` | Plan/trial expired — see [Error responses](#error-responses) |

---

## `GET /device-request/:id/status` {#poll}

`/{tenantSlug}/api/users/device-request/:requestId/status` — **no auth required**

Call this every 3–5 seconds after receiving a 202 from login. There is no push notification to the
waiting device for this — it doesn't have a token yet, so polling is the only option. Stop polling
once you get `active` or `rejected`.

Using the unified path? Append `?tenantSlug=acme-co` to this request the same way login accepted it
in the body.

### `200` — `status: "pending"`

Keep polling.

```json
{ "success": true, "status": "pending" }
```

### `200` — `status: "active"`

Admin approved it, sign-in complete.

```json
{
  "success": true,
  "status": "active",
  "_id": "665f1a2b3c4d5e6f7a8b9c0d",
  "name": "Jane Rep",
  "email": "rep@acme.co",
  "profileImage": null,
  "role": { "...": "..." },
  "slug": "acme-co",
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

Same shape as a 200 from `login` — treat it identically: store the token, proceed into the app. The
previously-active mobile device is signed out automatically at this point.

### `200` — `status: "rejected"`

Admin declined it.

```json
{ "success": true, "status": "rejected" }
```

Stop polling, return to the sign-in screen with a clear message (e.g. "Login request was declined").

---

## `POST /users/logout` {#logout}

`/{tenantSlug}/api/users/logout` — **bearer token required**

Ends this device's session only — the web session (if any) stays signed in. Frees the mobile slot
immediately, so signing back in on the same or a different phone works without needing approval again
if the slot is now empty.

### `200` — Signed out

```json
{ "message": "Logout successful" }
```

---

## `POST /location/update` {#loc-update}

`/{tenantSlug}/api/location/update` — **bearer token required**

Overwrites this rep's last-known position and pushes it to any Admin currently viewing the Live
Locations map in the CRM. There's no separate "start/stop tracking" call — every successful request
here is what makes the rep show up as live.

> **No server-side polling of the device.** Call this on your own interval while the app is in the
> foreground — the web client reports roughly every 30 seconds. If the app stops calling this
> endpoint, the rep simply goes stale on the map (no error, no state change — the last point just
> stops updating).

### Request body

| Field | Type | Notes |
|---|---|---|
| `latitude` **required** | number | Decimal degrees. |
| `longitude` **required** | number | Decimal degrees. |
| `accuracy` *optional* | number | Radius in meters, if the platform's location API provides it. Stored for display only — not used to filter or validate points. |

```json
{ "latitude": 13.0827, "longitude": 80.2707, "accuracy": 15 }
```

### `200` — Position recorded

```json
{ "success": true }
```

### `400` — Missing or non-numeric latitude/longitude

```json
{ "success": false, "message": "latitude and longitude are required" }
```

---

## Error responses

Shape is consistent across every endpoint above.

| Status | Meaning | Body |
|---|---|---|
| `401` | Bad credentials, or the token is stale — expired, superseded by a device-approval, or invalidated by a password change. | `{ "message": "..." }` |
| `401` (`sessionRevoked`) | Specifically: this device's session was ended (an Admin approved a different device of the same type, or this device signed out). Treat as a forced sign-out, not a generic auth error — return straight to the sign-in screen. | `{ "message": "This session was ended. Please sign in again.", "sessionRevoked": true }` |
| `403` (`planExpired`) | The workspace's subscription or trial has lapsed. | `{ "planExpired": true, "trialExpired": bool, "expiryDate": "...", "message": "..." }` |
| `404` | Unknown workspace slug, or an approval `requestId` that doesn't exist. | `{ "success": false, "message": "..." }` |
| `500` | Unexpected server error. | `{ "success": false, "message": "..." }` |

---

## Field glossary

| Field | Applies to | Meaning |
|---|---|---|
| `deviceType` | login | Always `"mobile"` from the app. The other value, `"web"`, is the browser client's own slot — the two never compete with each other. |
| `deviceId` | login | Your app's stable per-install id. Reused across logins on the same install; a new value reads as a new physical device. |
| `sessionId` | internal | Embedded inside the JWT, not something the client reads or sends directly. It's what lets the server sign out one device without touching the other. |
| `slug` | login, poll | The workspace identifier — prefix every subsequent request's URL with `/{slug}/api/…`. |
| `requestId` | login (202), poll | Identifies one pending device-approval request. Discard it once polling ends (approved or rejected). |

---

*Backed by `SAAS_CRM_BACKEND` — `controllers/user.controller.js`, `controllers/location.controller.js`,
`middlewares/auth.middleware.js`. Web reference implementation: `src/pages/auth/login.jsx`,
`src/components/LocationReporter.jsx`.*
