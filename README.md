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

**Until TikTok audits your app, everything you post is private (`SELF_ONLY`).** The audit is free; see step 6.
While you wait, use `mode: "draft"`. It sends the video to your TikTok inbox, and you tap *Post* in the app.

---

## Setup (about 20 minutes, all in the browser)

GitHub Actions does all the Cloudflare work for you: it creates the storage, deploys the server, turns on the
scheduler and copies your keys in. You only need to make accounts and paste a few values into GitHub.

All the secrets below go in this repo under **Settings → Secrets and variables → Actions → New repository secret**.

### 1. Cloudflare: account and API token (about 5 minutes)
1. Sign up at <https://dash.cloudflare.com/sign-up> (free, no card). Click **Workers & Pages** once, so Cloudflare
   gives you a free `*.workers.dev` address.
2. Go to **My Profile → API Tokens → Create Token**, choose the **"Edit Cloudflare Workers"** template, and click
   **Continue to summary → Create Token**. Copy the token.
3. Copy your **Account ID**. It's on the Workers & Pages page, in the right sidebar.
4. Add these GitHub secrets:
   - `CLOUDFLARE_API_TOKEN`: the token
   - `CLOUDFLARE_ACCOUNT_ID`: the account ID
   - `MCP_SECRET`: a long random password you make up, for example from
     <https://1password.com/password-generator>. Save it somewhere too, because you'll need it in steps 4 and 5.
     **Anyone with this password can control your TikTok.**
5. In GitHub, go to **Actions → Deploy to Cloudflare Workers → Run workflow**. When it goes green, open the run.
   Its summary lists all your URLs, for example `https://tiktok-mcp.YOURNAME.workers.dev`.

### 2. TikTok: developer app (about 10 minutes)
1. Go to <https://developers.tiktok.com/>, log in, and open **Manage apps → Connect an app**.
2. Copy these from the GitHub run summary:
   - **Terms of Service URL:** `…/terms`
   - **Privacy Policy URL:** `…/privacy`
   - **Platform:** Web, using your worker URL as the website
3. **Add products:** **Login Kit** and **Content Posting API**. Turn on *Direct Post* in the Content Posting API settings.
4. **Login Kit redirect URI:** `…/auth/callback`
5. **Scopes:** `user.info.basic`, `user.info.profile`, `user.info.stats`, `video.list`, `video.publish`, `video.upload`
6. To test before review, switch to **Sandbox** and add your own TikTok account under **Target users**.

> If TikTok asks you to verify URL ownership, choose the *file* method. Put the file name and its contents in
> `TIKTOK_VERIFY_FILENAME` / `TIKTOK_VERIFY_CONTENT` in `wrangler.toml`, commit (this redeploys automatically),
> and then click Verify.

### 3. Give the server your TikTok keys
Add two more GitHub secrets, `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET`, from the TikTok app page.
Then run the workflow again (**Actions → Run workflow**) to copy them into Cloudflare.

### 4. Connect your TikTok account
Open `https://tiktok-mcp.YOURNAME.workers.dev/auth/login?key=YOUR_MCP_SECRET` and approve. You should see **"TikTok connected ✅"**.

### 5. Connect your AI agent
Your MCP server URL is:

```
https://tiktok-mcp.YOURNAME.workers.dev/mcp/YOUR_MCP_SECRET
```

- **Claude (web, desktop or mobile):** Settings → Connectors → *Add custom connector*, then paste the URL.
- **Claude Code:** `claude mcp add --transport http tiktok https://tiktok-mcp.YOURNAME.workers.dev/mcp/YOUR_MCP_SECRET`
- **Any other MCP client** (Cursor, VS Code, n8n, etc.): use the URL as a "Streamable HTTP" server. You can also use
  `…/mcp` with the header `Authorization: Bearer YOUR_MCP_SECRET`.

### 6. Go public (optional, free)
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
