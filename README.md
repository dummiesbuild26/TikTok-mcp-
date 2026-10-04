# TikTok MCP: let an AI agent run your TikTok (100% free)

This is a small server that runs on **Cloudflare Workers (free tier)** and connects to your TikTok account through
**TikTok's official API**. It exposes your account as an **MCP server**, so an AI agent such as Claude can:

| Tool | What it does |
|---|---|
| `get_profile` | Followers, likes, video count, bio |
| `list_videos` / `get_video_stats` | Views, likes, comments and shares per video |
| `analyze_performance` | Averages, engagement rate, top/bottom posts, best posting hours |
| `get_creator_info` | What you're allowed to post right now (privacy options, max length) |
| `post_video` | Post an MP4 from a public link, either straight to your profile or to your TikTok drafts/inbox |
| `post_photos` | Post a photo carousel |
| `get_post_status` | Check whether a post finished processing |
| `schedule_post` / `list_scheduled_posts` / `cancel_scheduled_post` | Content calendar; the server posts automatically |

Example prompt once connected: *"Look at my last 40 videos, tell me what's working, then schedule this video
for my best time tomorrow with a caption and hashtags in the style of my top posts."*

## What it costs: £0 / $0

| Piece | Free allowance | What this uses |
|---|---|---|
| Cloudflare Workers | 100,000 requests/day | A few hundred |
| Cloudflare KV | 100k reads, 1k writes/day | Tokens and the schedule |
| Cron Triggers | Included | 1 (every 5 minutes) |
| GitHub + Actions | Free | Code and auto-deploy |
| TikTok Developer API | Free | Login Kit and Content Posting API |

You don't need a credit card for any of this.

## What TikTok's API can't do (be aware)

TikTok's official API **does not** allow replying to comments, sending DMs, following or liking, or reading the
For You page. This server avoids unofficial "bot" browser automation on purpose, because that breaks TikTok's
rules and gets accounts banned.

**Until TikTok audits your app, everything you post is private (`SELF_ONLY`).** The audit is free; see step 7.
While you wait, use `mode: "draft"`. It sends the video to your TikTok inbox, and you tap *Post* in the app.

---

## Setup (about 30 minutes, all in the browser)

### 1. Create a free Cloudflare account and KV storage
1. Sign up at <https://dash.cloudflare.com/sign-up>.
2. Go to **Storage & Databases → KV → Create**, and name it `TIKTOK_KV`.
3. Copy its **ID**. In this GitHub repo, open `wrangler.toml`, click the ✏️ pencil, and replace
   `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` with the ID. Then commit.

### 2. Let GitHub deploy to Cloudflare
1. In Cloudflare, open **My Profile → API Tokens → Create Token** and use the **"Edit Cloudflare Workers"** template.
   Copy the token.
2. Copy your **Account ID**. It's on the Workers & Pages overview page, in the right sidebar.
3. In GitHub, go to **Settings → Secrets and variables → Actions → New repository secret** and add:
   - `CLOUDFLARE_API_TOKEN`: the token
   - `CLOUDFLARE_ACCOUNT_ID`: the account ID
4. Go to **Actions → Deploy to Cloudflare Workers → Run workflow**. When it finishes, the log shows your URL, for example
   `https://tiktok-mcp.YOURNAME.workers.dev`. From then on, every push deploys automatically.

### 3. Create a TikTok developer app
1. Go to <https://developers.tiktok.com/>, log in, and open **Manage apps → Connect an app**.
2. Fill in the app details:
   - **Terms of Service URL:** `https://tiktok-mcp.YOURNAME.workers.dev/terms`
   - **Privacy Policy URL:** `https://tiktok-mcp.YOURNAME.workers.dev/privacy`
   - **Platform:** Web, using your worker URL as the website
3. **Add products:** **Login Kit** and **Content Posting API**. Turn on *Direct Post* in the Content Posting API settings.
4. **Login Kit redirect URI:** `https://tiktok-mcp.YOURNAME.workers.dev/auth/callback`
5. **Scopes:** `user.info.basic`, `user.info.profile`, `user.info.stats`, `video.list`, `video.publish`, `video.upload`
6. To test before review, switch to **Sandbox** and add your own TikTok account under **Target users**.
7. Copy the **Client key** and **Client secret**.

> If TikTok asks you to verify URL ownership, choose the *file* method. Put the file name and its contents in
> `TIKTOK_VERIFY_FILENAME` / `TIKTOK_VERIFY_CONTENT` in `wrangler.toml`, commit, and then click Verify.

### 4. Add your secrets to the Worker
In Cloudflare, open **Workers & Pages → tiktok-mcp → Settings → Variables and Secrets** and add three **Secrets**:
- `TIKTOK_CLIENT_KEY`
- `TIKTOK_CLIENT_SECRET`
- `MCP_SECRET`: a long random password, for example from <https://1password.com/password-generator>.
  **Anyone with this password can control your TikTok, so keep it private.**

### 5. Connect your TikTok account
Open `https://tiktok-mcp.YOURNAME.workers.dev/auth/login?key=YOUR_MCP_SECRET` and approve. You should see **"TikTok connected ✅"**.

### 6. Connect your AI agent
Your MCP server URL is:

```
https://tiktok-mcp.YOURNAME.workers.dev/mcp/YOUR_MCP_SECRET
```

- **Claude (web, desktop or mobile):** Settings → Connectors → *Add custom connector*, then paste the URL.
- **Claude Code:** `claude mcp add --transport http tiktok https://tiktok-mcp.YOURNAME.workers.dev/mcp/YOUR_MCP_SECRET`
- **Any other MCP client** (Cursor, VS Code, n8n, etc.): use the URL as a "Streamable HTTP" server. You can also use
  `…/mcp` with the header `Authorization: Bearer YOUR_MCP_SECRET`.

### 7. Go public (optional, free)
In the TikTok developer portal, submit the app for review. Explain that it's a personal tool for posting to your own
account, and include a short screen recording of the login and of a post being made. Once it's approved, posts can be
`PUBLIC_TO_EVERYONE`.

---

## Video files
`post_video` needs a **direct download link** to an MP4 of **60 MB or less**. That limit comes from the free Worker's
memory. Free options for hosting the file:
- **GitHub:** upload the file to a Release and use the asset link.
- **Google Drive:** share the file, then use `https://drive.google.com/uc?export=download&id=FILE_ID`
  (works for files under about 25 MB).
- **Dropbox:** share the link and change `dl=0` to `dl=1`.

Photo posts (`post_photos`) are different. TikTok fetches the images itself, so they must be hosted on a domain
you've verified in the TikTok portal. For example, you can put the images on GitHub Pages and verify that domain.

## Run it locally (optional)
```bash
npm install
cp .dev.vars.example .dev.vars   # fill in values
npm run dev                      # http://localhost:8787
```

## Project layout
```
src/index.ts      routes: OAuth login, /mcp, terms/privacy pages, cron
src/mcp.ts        MCP protocol (JSON-RPC over Streamable HTTP)
src/tools.ts      the tools the agent can call
src/tiktok.ts     TikTok API client (token refresh, uploads, stats)
src/scheduler.ts  scheduled posts in KV and the cron publisher
```
