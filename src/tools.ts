// MCP tool definitions exposed to the agent.

import {
  Env, PostOptions, getCreatorInfo, getPublishStatus, getUserInfo, listVideos,
  postPhotos, postVideo, queryVideos,
} from "./tiktok";
import { cancelScheduled, listScheduled, schedulePost } from "./scheduler";

type Args = Record<string, any>;

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (env: Env, args: Args) => Promise<unknown>;
}

const postOptionProps = {
  caption: { type: "string", description: "Caption incl. #hashtags and @mentions (max 2200 chars)." },
  privacy_level: {
    type: "string",
    enum: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"],
    description: "Defaults to SELF_ONLY. Unaudited TikTok apps may ONLY use SELF_ONLY. Check get_creator_info for allowed values.",
  },
  disable_comment: { type: "boolean" },
  disable_duet: { type: "boolean" },
  disable_stitch: { type: "boolean" },
  is_ai_generated: { type: "boolean", description: "Label the content as AI-generated." },
  brand_content_toggle: { type: "boolean", description: "Paid partnership / promoting a third-party brand." },
  brand_organic_toggle: { type: "boolean", description: "Promoting the creator's own business." },
  mode: {
    type: "string",
    enum: ["direct", "draft"],
    description: "direct = publish to profile now. draft = send to the TikTok app inbox so the owner can finish and post it manually.",
  },
};

function options(a: Args): PostOptions {
  return {
    caption: a.caption ?? "",
    privacy_level: a.privacy_level,
    disable_comment: a.disable_comment,
    disable_duet: a.disable_duet,
    disable_stitch: a.disable_stitch,
    is_ai_generated: a.is_ai_generated,
    brand_content_toggle: a.brand_content_toggle,
    brand_organic_toggle: a.brand_organic_toggle,
  };
}

function parseTime(value: string): number {
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new Error(`Invalid publish_at "${value}". Use ISO 8601, e.g. 2026-10-05T18:00:00Z.`);
  return t;
}

export const tools: Tool[] = [
  {
    name: "get_profile",
    description: "Get the connected TikTok account's profile and stats (followers, likes, video count).",
    inputSchema: { type: "object", properties: {} },
    handler: (env) => getUserInfo(env),
  },
  {
    name: "list_videos",
    description: "List the account's recent videos with views, likes, comments and shares. Paginate with cursor.",
    inputSchema: {
      type: "object",
      properties: {
        max_count: { type: "number", description: "1-20, default 20" },
        cursor: { type: "number", description: "cursor from a previous call" },
      },
    },
    handler: (env, a) => listVideos(env, a.max_count ?? 20, a.cursor),
  },
  {
    name: "get_video_stats",
    description: "Get current stats for specific video IDs (up to 20).",
    inputSchema: {
      type: "object",
      properties: { video_ids: { type: "array", items: { type: "string" } } },
      required: ["video_ids"],
    },
    handler: (env, a) => queryVideos(env, a.video_ids),
  },
  {
    name: "analyze_performance",
    description: "Summarise performance across the most recent videos: averages, engagement rate, best and worst posts, best posting hours (UTC).",
    inputSchema: {
      type: "object",
      properties: { videos: { type: "number", description: "How many recent videos to analyse (default 40, max 100)" } },
    },
    handler: async (env, a) => {
      const want = Math.min(a.videos ?? 40, 100);
      const videos: Record<string, any>[] = [];
      let cursor: number | undefined;
      while (videos.length < want) {
        const page = await listVideos(env, 20, cursor);
        videos.push(...page.videos);
        if (!page.has_more) break;
        cursor = page.cursor;
      }
      const sample = videos.slice(0, want);
      if (sample.length === 0) return { message: "No videos found." };
      const n = (v: any) => Number(v ?? 0);
      const engagement = (v: Record<string, any>) =>
        n(v.view_count) ? (n(v.like_count) + n(v.comment_count) + n(v.share_count)) / n(v.view_count) : 0;
      const avg = (f: (v: any) => number) => Math.round(sample.reduce((s, v) => s + f(v), 0) / sample.length);
      const byViews = [...sample].sort((x, y) => n(y.view_count) - n(x.view_count));
      const hours: Record<number, { posts: number; views: number }> = {};
      for (const v of sample) {
        const h = new Date(n(v.create_time) * 1000).getUTCHours();
        hours[h] ??= { posts: 0, views: 0 };
        hours[h].posts++;
        hours[h].views += n(v.view_count);
      }
      const brief = (v: Record<string, any>) => ({
        id: v.id, title: v.title, views: v.view_count, likes: v.like_count,
        engagement_rate: `${(engagement(v) * 100).toFixed(2)}%`, url: v.share_url,
      });
      return {
        videos_analysed: sample.length,
        avg_views: avg((v) => n(v.view_count)),
        avg_likes: avg((v) => n(v.like_count)),
        avg_comments: avg((v) => n(v.comment_count)),
        avg_shares: avg((v) => n(v.share_count)),
        avg_engagement_rate: `${((sample.reduce((s, v) => s + engagement(v), 0) / sample.length) * 100).toFixed(2)}%`,
        top_5: byViews.slice(0, 5).map(brief),
        bottom_5: byViews.slice(-5).reverse().map(brief),
        avg_views_by_posting_hour_utc: Object.entries(hours)
          .map(([h, s]) => ({ hour: Number(h), posts: s.posts, avg_views: Math.round(s.views / s.posts) }))
          .sort((x, y) => y.avg_views - x.avg_views),
      };
    },
  },
  {
    name: "get_creator_info",
    description: "Check what the account may post right now: allowed privacy levels, max video length, whether comments/duet/stitch are disabled. Call before posting.",
    inputSchema: { type: "object", properties: {} },
    handler: (env) => getCreatorInfo(env),
  },
  {
    name: "post_video",
    description: "Publish an MP4 video from a public direct-download URL (max 60 MB). Returns a publish_id; check it with get_post_status.",
    inputSchema: {
      type: "object",
      properties: { video_url: { type: "string" }, ...postOptionProps },
      required: ["video_url", "caption"],
    },
    handler: (env, a) => postVideo(env, a.video_url, options(a), a.mode ?? "direct"),
  },
  {
    name: "post_photos",
    description: "Publish a photo carousel (1-35 JPG/WEBP images). Image URLs must be on a domain verified in the TikTok Developer Portal.",
    inputSchema: {
      type: "object",
      properties: {
        image_urls: { type: "array", items: { type: "string" } },
        title: { type: "string", description: "Short title (max 90 chars)" },
        ...postOptionProps,
      },
      required: ["image_urls", "caption"],
    },
    handler: (env, a) => postPhotos(env, a.image_urls, { ...options(a), title: a.title }, a.mode ?? "direct"),
  },
  {
    name: "get_post_status",
    description: "Check the processing/publish status of a post by publish_id.",
    inputSchema: { type: "object", properties: { publish_id: { type: "string" } }, required: ["publish_id"] },
    handler: (env, a) => getPublishStatus(env, a.publish_id),
  },
  {
    name: "schedule_post",
    description: "Schedule a video or photo post for later. The server publishes it automatically (checked every 5 minutes).",
    inputSchema: {
      type: "object",
      properties: {
        publish_at: { type: "string", description: "ISO 8601 time, e.g. 2026-10-05T18:00:00Z" },
        video_url: { type: "string", description: "Set this for a video post" },
        image_urls: { type: "array", items: { type: "string" }, description: "Set this for a photo post" },
        title: { type: "string", description: "Photo post title" },
        ...postOptionProps,
      },
      required: ["publish_at", "caption"],
    },
    handler: async (env, a) => {
      if (!a.video_url && !a.image_urls?.length) throw new Error("Provide video_url or image_urls.");
      const entry = await schedulePost(env, {
        publish_at: parseTime(a.publish_at),
        kind: a.video_url ? "video" : "photos",
        mode: a.mode ?? "direct",
        video_url: a.video_url,
        image_urls: a.image_urls,
        title: a.title,
        options: options(a),
      });
      return { ...entry, publish_at: new Date(entry.publish_at).toISOString() };
    },
  },
  {
    name: "list_scheduled_posts",
    description: "List scheduled posts and the results of recently published ones.",
    inputSchema: { type: "object", properties: {} },
    handler: async (env) =>
      (await listScheduled(env)).map((p) => ({ ...p, publish_at: new Date(p.publish_at).toISOString() })),
  },
  {
    name: "cancel_scheduled_post",
    description: "Cancel a pending scheduled post by id.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: async (env, a) => ({ cancelled: await cancelScheduled(env, a.id) }),
  },
];
