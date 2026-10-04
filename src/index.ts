import { handleMcp } from "./mcp";
import { runScheduled } from "./scheduler";
import { Env, exchangeCode, getStoredToken } from "./tiktok";

function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function page(title: string, body: string, status = 200) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.5}code{background:#eee;padding:2px 4px;border-radius:4px}</style>
</head><body><h1>${title}</h1>${body}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function redirectUri(url: URL) {
  return `${url.origin}/auth/callback`;
}

async function handleLogin(url: URL, env: Env) {
  if (!safeEqual(url.searchParams.get("key") ?? "", env.MCP_SECRET)) {
    return page("Forbidden", "<p>Add <code>?key=YOUR_MCP_SECRET</code> to the URL.</p>", 403);
  }
  const state = crypto.randomUUID();
  await env.KV.put(`oauth_state:${state}`, "1", { expirationTtl: 600 });
  const auth = new URL("https://www.tiktok.com/v2/auth/authorize/");
  auth.searchParams.set("client_key", env.TIKTOK_CLIENT_KEY);
  auth.searchParams.set("scope", env.TIKTOK_SCOPES);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("redirect_uri", redirectUri(url));
  auth.searchParams.set("state", state);
  return Response.redirect(auth.toString(), 302);
}

async function handleCallback(url: URL, env: Env) {
  const err = url.searchParams.get("error");
  if (err) return page("TikTok login failed", `<p>${err}: ${url.searchParams.get("error_description") ?? ""}</p>`, 400);
  const state = url.searchParams.get("state") ?? "";
  if (!state || !(await env.KV.get(`oauth_state:${state}`))) {
    return page("Login expired", "<p>Invalid or expired state. Start again from /auth/login.</p>", 400);
  }
  await env.KV.delete(`oauth_state:${state}`);
  const token = await exchangeCode(env, url.searchParams.get("code") ?? "", redirectUri(url));
  return page(
    "TikTok connected ✅",
    `<p>Granted scopes: <code>${token.scope}</code></p>
<p>Your MCP endpoint is <code>${url.origin}/mcp/&lt;MCP_SECRET&gt;</code>. Add it to your agent as a remote MCP server.</p>`,
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // MCP endpoint: secret in the path (for clients without header support) or as a Bearer token.
      if (path.startsWith("/mcp")) {
        const pathSecret = path.slice("/mcp/".length);
        const bearer = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
        if (!safeEqual(pathSecret, env.MCP_SECRET) && !safeEqual(bearer, env.MCP_SECRET)) {
          return new Response("Unauthorized", { status: 401 });
        }
        return handleMcp(request, env);
      }

      if (path === "/auth/login") return handleLogin(url, env);
      if (path === "/auth/callback") return handleCallback(url, env);

      if (env.TIKTOK_VERIFY_FILENAME && path === `/${env.TIKTOK_VERIFY_FILENAME}`) {
        return new Response(env.TIKTOK_VERIFY_CONTENT ?? "", { headers: { "Content-Type": "text/plain" } });
      }

      // TikTok's app review requires public Terms of Service and Privacy Policy URLs.
      if (path === "/terms") {
        return page("Terms of Service", `<p>This is a personal tool used by its owner to manage their own TikTok account
through the official TikTok API. It is not offered to the public. By connecting, you confirm you are the owner of the account
and accept TikTok's own Terms of Service.</p>`);
      }
      if (path === "/privacy") {
        return page("Privacy Policy", `<p>This personal tool stores only the TikTok OAuth tokens and scheduled-post entries needed
to operate the owner's own account, in Cloudflare KV. No data is sold or shared with third parties. Data is used solely to
display account statistics and publish content the owner requests. To delete your data, revoke the app's access in TikTok
settings; tokens are then useless and scheduled entries expire automatically.</p>`);
      }

      if (path === "/") {
        const token = await getStoredToken(env);
        return page(
          "TikTok MCP",
          token
            ? `<p>Status: connected ✅ (scopes: <code>${token.scope}</code>)</p>`
            : `<p>Status: not connected. Visit <code>/auth/login?key=YOUR_MCP_SECRET</code>.</p>`,
        );
      }
      return new Response("Not found", { status: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return page("Error", `<p>${message.replace(/</g, "&lt;")}</p>`, 500);
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env));
  },
} satisfies ExportedHandler<Env>;
