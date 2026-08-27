// Google OAuth for this project -- separate cached token from the other two
// scripts' logins (even though all three reuse the same oauth-client.json
// app), because the scopes differ: this project needs Calendar event
// read/write plus read-only Drive (to fetch the raw .xlsx schedule file), no
// Sheets access at all. Keeping the token separate means this project's
// consent can't silently widen or narrow what the others already have
// cached.
//
// Runs its own tiny local-server OAuth flow rather than using
// @google-cloud/local-auth, for two confirmed-live reasons:
//
// 1. Version mismatch: this repo's node_modules has two incompatible
//    google-auth-library majors installed side by side -- @google-cloud/
//    local-auth pulls v9 (hoisted to the top-level node_modules), while
//    `googleapis` bundles its own v10 nested inside node_modules/googleapis.
//    A v9 OAuth2Client instance doesn't attach credentials the way
//    googleapis' internal v10 code expects when building requests, so calls
//    silently go out unauthenticated -- a real "401 Login Required" even
//    immediately after a genuinely successful browser consent (confirmed:
//    browser showed "Authentication successful", very next API call still
//    401'd). Fixed by only ever building OAuth2Client via `googleapis`'s own
//    `google.auth.OAuth2` (guaranteed to match the v10 its request-building
//    code expects).
//
// 2. Missing prompt=consent: @google-cloud/local-auth's generateAuthUrl call
//    hardcodes access_type: 'offline' but never sets prompt: 'consent', and
//    exposes no option to add it. Confirmed live: after this project's scope
//    list grew (drive.readonly -> + calendar.events), repeat runs kept
//    showing a real browser consent screen but Google silently re-issued a
//    token scoped to only the *original* grant, dropping the new scope
//    entirely -- because without prompt=consent, Google treats it as "user
//    already authorized this app" and skips actually re-prompting for the
//    delta. Every retry produced the exact same 403 ACCESS_TOKEN_SCOPE_
//    INSUFFICIENT until this was forced. Owning the auth URL ourselves lets
//    us always pass prompt: 'consent', which is required practically any
//    time scopes change after a first grant.

import { google } from "googleapis";
import http from "node:http";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// calendar.events (not full "calendar") is deliberate: it can create,
// update, and delete events, but can't touch calendar settings/ACLs/list
// calendars a user hasn't already granted access to. gmail.send (not
// gmail.compose or full "mail.google.com") is the least-privilege scope
// that can send mail -- it cannot read, search, or delete anything in the
// mailbox.
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];

function readClientKey(clientSecretFile) {
  const keys = JSON.parse(fs.readFileSync(clientSecretFile, "utf8"));
  return keys.installed ?? keys.web;
}

// Builds an OAuth2Client from googleapis' own bundled auth library (see
// note above for why this matters), with the given tokens attached.
// Persisting/refreshing both go through this same instance so credentials
// never cross the version boundary again after this point.
function buildClient(clientSecretFile, tokens) {
  const key = readClientKey(clientSecretFile);
  const client = new google.auth.OAuth2(key.client_id, key.client_secret, key.redirect_uris?.[0]);
  client.setCredentials(tokens);
  return client;
}

function loadSavedTokens(tokenFile) {
  if (!fs.existsSync(tokenFile)) return null;
  return JSON.parse(fs.readFileSync(tokenFile, "utf8"));
}

function saveTokens(tokenFile, tokens) {
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, JSON.stringify(tokens));
}

// Opens `url` in the default browser. macOS-only (`open`), matching this
// repo's other scripts which are all local-machine tools for one user.
function openBrowser(url) {
  execFile("open", [url]);
}

// Runs a one-time interactive consent flow: starts an ephemeral local HTTP
// server, opens the browser to Google's consent screen with prompt:
// 'consent' (see file header for why that's required), and resolves once
// the redirect lands with an auth code, exchanged for tokens.
function interactiveConsent(client, scopes) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, "http://localhost");
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        if (error) throw new Error(`Google returned an error: ${error}`);
        if (!code) return; // ignore favicon.ico etc.

        res.end("Authentication successful! You can close this tab and return to the terminal.");
        server.close();

        const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
        resolve(tokens);
      } catch (err) {
        res.end(`Authentication failed: ${err.message}`);
        server.close();
        reject(err);
      }
    });

    let redirectUri;
    server.listen(0, "localhost", () => {
      redirectUri = `http://localhost:${server.address().port}`;
      const authorizeUrl = client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent", // force a fresh grant covering the full current scope list
        scope: scopes,
        redirect_uri: redirectUri,
      });
      console.log("Opening a browser tab for one-time sign-in (Calendar events read/write + Drive read-only)...");
      openBrowser(authorizeUrl);
    });

    server.on("error", reject);
  });
}

export async function getGoogleAuthClient(clientSecretFile, tokenFile) {
  const saved = loadSavedTokens(tokenFile);
  if (saved) {
    const client = buildClient(clientSecretFile, saved);
    // Refresh eagerly rather than waiting for a 401 -- the access_token in
    // the saved file is very likely already expired (they last ~1hr), and
    // this keeps the persisted file's access_token current for next run too.
    client.on("tokens", (tokens) => saveTokens(tokenFile, { ...saved, ...tokens }));
    await client.getAccessToken();
    return client;
  }

  const client = buildClient(clientSecretFile, {});
  const tokens = await interactiveConsent(client, SCOPES);
  if (!tokens.refresh_token) {
    throw new Error("Google didn't return a refresh_token -- if you've consented to this app+scopes before, revoke access at https://myaccount.google.com/permissions and try again so Google issues a fresh one.");
  }
  client.setCredentials(tokens);
  saveTokens(tokenFile, client.credentials);
  client.on("tokens", (newTokens) => saveTokens(tokenFile, { ...client.credentials, ...newTokens }));
  return client;
}
