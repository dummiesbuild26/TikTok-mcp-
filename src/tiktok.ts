// Thin client for TikTok's official Open API (v2).
// Docs: https://developers.tiktok.com/doc/overview

export interface Env {
  KV: KVNamespace;
  TIKTOK_CLIENT_KEY: string;
  TIKTOK_CLIENT_SECRET: string;
  MCP_SECRET: string;
  TIKTOK_SCOPES: string;
  TIKTOK_VERIFY_FILENAME?: string;
  TIKTOK_VERIFY_CONTENT?: string;
}

const API = "https://open.tiktokapis.com";
const TOKEN_KEY = "tiktok:token";

interface StoredToken {
  access_token: string;
  refresh_token: string;
  open_id: string;
  scope: string;
  expires_at: number; // ms epoch
  refresh_expires_at: number; // ms epoch
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  open_id: string;
  scope: string;
  expires_in: number;
  refresh_expires_in: number;
  error?: string;
  error_description?: string;
}

export class TikTokError extends Error {}

async function requestToken(env: Env, params: Record<string, string>): Promise<StoredToken> {
  const res = await fetch(`${API}/v2/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: env.TIKTOK_CLIENT_KEY,
      client_secret: env.TIKTOK_CLIENT_SECRET,
      ...params,
    }),
  });
  const data = (await res.json()) as TokenResponse;
  if (!res.ok || data.error || !data.access_token) {
    throw new TikTokError(`Token request failed: ${data.error ?? res.status} ${data.error_description ?? ""}`.trim());
  }
  const now = Date.now();
  const token: StoredToken = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    open_id: data.open_id,
    scope: data.scope,
    expires_at: now + data.expires_in * 1000,
    refresh_expires_at: now + data.refresh_expires_in * 1000,
  };
  await env.KV.put(TOKEN_KEY, JSON.stringify(token));
  return token;
}

export function exchangeCode(env: Env, code: string, redirectUri: string) {
  return requestToken(env, { code, grant_type: "authorization_code", redirect_uri: redirectUri });
}

export async function getStoredToken(env: Env): Promise<StoredToken | null> {
  return env.KV.get<StoredToken>(TOKEN_KEY, "json");
}

/** Returns a valid access token, refreshing it if it expires within `marginMs`. */
export async function getAccessToken(env: Env, marginMs = 5 * 60_000): Promise<string> {
  const token = await getStoredToken(env);
  if (!token) {
    throw new TikTokError("TikTok account not connected. Open /auth/login?key=<MCP_SECRET> on your worker to connect it.");
  }
  if (token.expires_at - Date.now() > marginMs) return token.access_token;
  if (token.refresh_expires_at < Date.now()) {
    throw new TikTokError("TikTok refresh token expired. Reconnect via /auth/login?key=<MCP_SECRET>.");
  }
  const refreshed = await requestToken(env, { grant_type: "refresh_token", refresh_token: token.refresh_token });
  return refreshed.access_token;
}

interface ApiEnvelope<T> {
  data: T;
  error: { code: string; message: string; log_id?: string };
}

async function api<T>(env: Env, path: string, body?: unknown): Promise<T> {
  const accessToken = await getAccessToken(env);
  const res = await fetch(`${API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as ApiEnvelope<T>;
  if (json.error && json.error.code !== "ok") {
    throw new TikTokError(`TikTok API ${path}: ${json.error.code} - ${json.error.message}`);
  }
  return json.data;
}

// ---------- Read ----------

const USER_FIELDS = [
  "open_id", "avatar_url", "display_name", "bio_description", "profile_deep_link",
  "is_verified", "username", "follower_count", "following_count", "likes_count", "video_count",
];

const VIDEO_FIELDS = [
  "id", "title", "video_description", "create_time", "duration", "cover_image_url",
  "share_url", "view_count", "like_count", "comment_count", "share_count",
];

export async function getUserInfo(env: Env) {
  const token = await getStoredToken(env);
  const scopes = token?.scope.split(",") ?? [];
  // Only ask for fields covered by granted scopes, otherwise TikTok rejects the call.
  const fields = USER_FIELDS.filter((f) => {
    if (["follower_count", "following_count", "likes_count", "video_count"].includes(f)) return scopes.includes("user.info.stats");
    if (["bio_description", "profile_deep_link", "is_verified", "username"].includes(f)) return scopes.includes("user.info.profile");
    return true;
  });
  const data = await api<{ user: Record<string, unknown> }>(env, `/v2/user/info/?fields=${fields.join(",")}`);
  return data.user;
}

export async function listVideos(env: Env, maxCount = 20, cursor?: number) {
  return api<{ videos: Record<string, unknown>[]; cursor: number; has_more: boolean }>(
    env,
    `/v2/video/list/?fields=${VIDEO_FIELDS.join(",")}`,
    { max_count: Math.min(Math.max(maxCount, 1), 20), ...(cursor ? { cursor } : {}) },
  );
}

export async function queryVideos(env: Env, videoIds: string[]) {
  return api<{ videos: Record<string, unknown>[] }>(
    env,
    `/v2/video/query/?fields=${VIDEO_FIELDS.join(",")}`,
    { filters: { video_ids: videoIds.slice(0, 20) } },
  );
}

// ---------- Publish ----------

export interface CreatorInfo {
  creator_username: string;
  creator_nickname: string;
  privacy_level_options: string[];
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
  max_video_post_duration_sec: number;
}

export function getCreatorInfo(env: Env) {
  return api<CreatorInfo>(env, "/v2/post/publish/creator_info/query/", {});
}

export interface PostOptions {
  caption: string;
  privacy_level?: string;
  disable_comment?: boolean;
  disable_duet?: boolean;
  disable_stitch?: boolean;
  is_ai_generated?: boolean;
  brand_content_toggle?: boolean;
  brand_organic_toggle?: boolean;
}

function postInfo(opts: PostOptions, privacy: string) {
  return {
    title: opts.caption,
    privacy_level: privacy,
    disable_comment: opts.disable_comment ?? false,
    disable_duet: opts.disable_duet ?? false,
    disable_stitch: opts.disable_stitch ?? false,
    is_aigc: opts.is_ai_generated ?? false,
    brand_content_toggle: opts.brand_content_toggle ?? false,
    brand_organic_toggle: opts.brand_organic_toggle ?? false,
  };
}

/** TikTok requires a privacy level the creator actually allows; unaudited apps only get SELF_ONLY. */
async function resolvePrivacy(env: Env, requested?: string): Promise<string> {
  const info = await getCreatorInfo(env);
  const options = info.privacy_level_options ?? [];
  const wanted = requested ?? "SELF_ONLY";
  if (options.includes(wanted)) return wanted;
  throw new TikTokError(`Privacy level "${wanted}" not allowed for this account/app. Allowed: ${options.join(", ")}`);
}

// Videos are fetched into Worker memory (128 MB limit) and uploaded in chunks.
const MAX_FETCHED_VIDEO_BYTES = 60 * 1024 * 1024;
const CHUNK_BYTES = 10 * 1024 * 1024;
const MIN_CHUNK_BYTES = 5 * 1024 * 1024;

async function downloadVideo(videoUrl: string): Promise<ArrayBuffer> {
  const res = await fetch(videoUrl, { redirect: "follow" });
  if (!res.ok) throw new TikTokError(`Could not download video (${res.status}) from ${videoUrl}`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_FETCHED_VIDEO_BYTES) {
    throw new TikTokError(`Video is ${(declared / 1048576).toFixed(1)} MB; max is 60 MB on the free Worker. Compress it first.`);
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_FETCHED_VIDEO_BYTES) throw new TikTokError("Video larger than 60 MB; compress it first.");
  if (buf.byteLength === 0) throw new TikTokError("Downloaded video is empty - is the URL a direct download link?");
  return buf;
}

function chunkPlan(size: number) {
  // TikTok: chunks are 5-64 MB, the final chunk absorbs the remainder; files under 5 MB go in one chunk.
  if (size < MIN_CHUNK_BYTES || size <= CHUNK_BYTES) return { chunkSize: size, count: 1 };
  return { chunkSize: CHUNK_BYTES, count: Math.floor(size / CHUNK_BYTES) };
}

async function uploadChunks(uploadUrl: string, video: ArrayBuffer, chunkSize: number, count: number) {
  const size = video.byteLength;
  for (let i = 0; i < count; i++) {
    const start = i * chunkSize;
    const end = i === count - 1 ? size : start + chunkSize; // exclusive
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
        "Content-Range": `bytes ${start}-${end - 1}/${size}`,
      },
      body: video.slice(start, end),
    });
    if (!res.ok && res.status !== 206) {
      throw new TikTokError(`Chunk ${i + 1}/${count} upload failed: ${res.status} ${await res.text()}`);
    }
  }
}

/**
 * Publish a video from a public URL.
 * mode "direct": posts straight to the profile (needs video.publish).
 * mode "draft":  sends it to the creator's TikTok inbox to finish in the app (needs video.upload).
 */
export async function postVideo(env: Env, videoUrl: string, opts: PostOptions, mode: "direct" | "draft" = "direct") {
  const video = await downloadVideo(videoUrl);
  const { chunkSize, count } = chunkPlan(video.byteLength);
  const source_info = {
    source: "FILE_UPLOAD",
    video_size: video.byteLength,
    chunk_size: chunkSize,
    total_chunk_count: count,
  };

  const init =
    mode === "direct"
      ? await api<{ publish_id: string; upload_url: string }>(env, "/v2/post/publish/video/init/", {
          post_info: postInfo(opts, await resolvePrivacy(env, opts.privacy_level)),
          source_info,
        })
      : await api<{ publish_id: string; upload_url: string }>(env, "/v2/post/publish/inbox/video/init/", { source_info });

  await uploadChunks(init.upload_url, video, chunkSize, count);
  return { publish_id: init.publish_id, mode, bytes: video.byteLength, chunks: count };
}

/** Photo carousel. TikTok pulls the images itself, so their URL prefix must be verified in the Developer Portal. */
export async function postPhotos(
  env: Env,
  imageUrls: string[],
  opts: PostOptions & { title?: string },
  mode: "direct" | "draft" = "direct",
) {
  const direct = mode === "direct";
  const info: Record<string, unknown> = { title: opts.title ?? "", description: opts.caption };
  if (direct) {
    Object.assign(info, {
      privacy_level: await resolvePrivacy(env, opts.privacy_level),
      disable_comment: opts.disable_comment ?? false,
      auto_add_music: true,
      brand_content_toggle: opts.brand_content_toggle ?? false,
      brand_organic_toggle: opts.brand_organic_toggle ?? false,
    });
  }
  return api<{ publish_id: string }>(env, "/v2/post/publish/content/init/", {
    post_info: info,
    source_info: { source: "PULL_FROM_URL", photo_cover_index: 0, photo_images: imageUrls.slice(0, 35) },
    post_mode: direct ? "DIRECT_POST" : "MEDIA_UPLOAD",
    media_type: "PHOTO",
  });
}

export function getPublishStatus(env: Env, publishId: string) {
  return api<Record<string, unknown>>(env, "/v2/post/publish/status/fetch/", { publish_id: publishId });
}
