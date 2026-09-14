const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const API_URL = "https://www.googleapis.com/youtube/v3";
const UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos";

function assertOk(response, label) {
  if (response.ok) return response;
  return response.text().then((body) => {
    throw new Error(`${label} failed (${response.status}): ${body.slice(0, 500)}`);
  });
}

export function buildAuthorizationUrl({ clientId, redirectUri, state }) {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  }).toString();
  return url.toString();
}

export async function exchangeAuthorizationCode({ clientId, clientSecret, redirectUri, code }) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
      grant_type: "authorization_code",
    }),
  });
  await assertOk(response, "YouTube OAuth exchange");
  return response.json();
}

export async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  await assertOk(response, "YouTube token refresh");
  return response.json();
}

export async function getOwnChannel(accessToken) {
  const response = await fetch(`${API_URL}/channels?part=id,snippet&mine=true`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  await assertOk(response, "YouTube channel lookup");
  const body = await response.json();
  const channel = body.items?.[0];
  if (!channel) throw new Error("The authorized Google account has no YouTube channel");
  return { id: channel.id, title: channel.snippet?.title || "YouTube" };
}

export function buildVideoMetadata({ title, description, privacyStatus = "private", publishAt = null }) {
  const allowed = new Set(["private", "unlisted", "public"]);
  if (!allowed.has(privacyStatus)) throw new Error("privacy_status must be private, unlisted or public");
  const status = {
    privacyStatus,
    selfDeclaredMadeForKids: true,
    containsSyntheticMedia: true,
    embeddable: true,
  };
  if (publishAt) {
    status.privacyStatus = "private";
    status.publishAt = new Date(publishAt).toISOString();
  }
  return {
    snippet: {
      title: String(title || "Lumi aprende jugando").slice(0, 100),
      description: String(description || "Una microclase de Lumi para aprender jugando. #Lumi #AprenderJugando #Shorts").slice(0, 5000),
      categoryId: "27",
      defaultLanguage: "es",
      tags: ["Lumi", "educación infantil", "aprender jugando", "Shorts"],
    },
    status,
  };
}

export async function uploadVideoBuffer({ accessToken, buffer, contentType = "video/mp4", metadata }) {
  const initiate = await fetch(`${UPLOAD_URL}?uploadType=resumable&part=snippet,status`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-length": String(buffer.length),
      "x-upload-content-type": contentType,
    },
    body: JSON.stringify(metadata),
  });
  await assertOk(initiate, "YouTube resumable upload initialization");
  const location = initiate.headers.get("location");
  if (!location) throw new Error("YouTube did not return a resumable upload location");

  const upload = await fetch(location, {
    method: "PUT",
    headers: { "content-type": contentType, "content-length": String(buffer.length) },
    body: buffer,
  });
  await assertOk(upload, "YouTube video upload");
  return upload.json();
}
