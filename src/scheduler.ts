// Scheduled posts stored in Workers KV and published by the cron trigger.

import { Env, PostOptions, getAccessToken, getStoredToken, postPhotos, postVideo } from "./tiktok";

export interface ScheduledPost {
  id: string;
  publish_at: number; // ms epoch
  kind: "video" | "photos";
  mode: "direct" | "draft";
  video_url?: string;
  image_urls?: string[];
  title?: string;
  options: PostOptions;
  status: "pending" | "publishing" | "published" | "failed";
  publish_id?: string;
  error?: string;
}

const PREFIX = "schedule:";
// Keep finished entries around for a week so the agent can see what happened.
const DONE_TTL_SECONDS = 7 * 24 * 3600;

export async function schedulePost(env: Env, post: Omit<ScheduledPost, "id" | "status">): Promise<ScheduledPost> {
  const entry: ScheduledPost = { ...post, id: crypto.randomUUID(), status: "pending" };
  await env.KV.put(PREFIX + entry.id, JSON.stringify(entry));
  return entry;
}

export async function listScheduled(env: Env): Promise<ScheduledPost[]> {
  const list = await env.KV.list({ prefix: PREFIX });
  const posts = await Promise.all(list.keys.map((k) => env.KV.get<ScheduledPost>(k.name, "json")));
  return posts.filter((p): p is ScheduledPost => p !== null).sort((a, b) => a.publish_at - b.publish_at);
}

export async function cancelScheduled(env: Env, id: string): Promise<boolean> {
  const existing = await env.KV.get<ScheduledPost>(PREFIX + id, "json");
  if (!existing || existing.status !== "pending") return false;
  await env.KV.delete(PREFIX + id);
  return true;
}

async function publish(env: Env, post: ScheduledPost) {
  // Claim the post first so an overlapping cron run doesn't publish it twice.
  await env.KV.put(PREFIX + post.id, JSON.stringify({ ...post, status: "publishing" }));
  try {
    const result =
      post.kind === "video"
        ? await postVideo(env, post.video_url!, post.options, post.mode)
        : await postPhotos(env, post.image_urls!, { ...post.options, title: post.title }, post.mode);
    post.status = "published";
    post.publish_id = result.publish_id;
  } catch (err) {
    post.status = "failed";
    post.error = err instanceof Error ? err.message : String(err);
  }
  await env.KV.put(PREFIX + post.id, JSON.stringify(post), { expirationTtl: DONE_TTL_SECONDS });
}

/** Cron handler: publish due posts and keep the access token warm. */
export async function runScheduled(env: Env) {
  if (!(await getStoredToken(env))) return;
  // Refresh an hour ahead so scheduled posts never hit an expired token.
  await getAccessToken(env, 60 * 60_000);
  const due = (await listScheduled(env)).filter((p) => p.status === "pending" && p.publish_at <= Date.now());
  for (const post of due) await publish(env, post);
}
