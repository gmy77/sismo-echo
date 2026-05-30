// ============================================================
// SISMO-ECHO — Secure Worker Entry
// Protective wrapper for sensitive update endpoints.
//
// Why this file exists:
// - index.js is the historical Worker implementation.
// - /update was protected by a hardcoded token inside index.js.
// - This wrapper moves the public-facing check to env.UPDATE_SECRET,
//   which must be configured as a Cloudflare Worker Secret.
//
// Setup:
//   npx wrangler secret put UPDATE_SECRET
// ============================================================

import worker from "./index.js";

const LEGACY_INTERNAL_UPDATE_SECRET = "mira755colo";

function getUpdateSecret(env) {
  return env?.UPDATE_SECRET || "";
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function isProtectedUpdatePath(pathname) {
  return pathname === "/update" || pathname === "/update/";
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (isProtectedUpdatePath(url.pathname)) {
      const expected = getUpdateSecret(env);
      const supplied = url.searchParams.get("token") || "";

      if (!expected) {
        return json({
          ok: false,
          error: "UPDATE_SECRET is not configured. Run: npx wrangler secret put UPDATE_SECRET",
        }, 500);
      }

      if (supplied !== expected) {
        return json({ ok: false, error: "Forbidden" }, 403);
      }

      // index.js still contains the legacy internal check. After the new
      // secret is validated here, forward the request using the legacy value
      // so the old implementation can continue without a risky full-file rewrite.
      url.searchParams.set("token", LEGACY_INTERNAL_UPDATE_SECRET);
      const forwardedRequest = new Request(url.toString(), request);
      return worker.fetch(forwardedRequest, env, ctx);
    }

    return worker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    if (typeof worker.scheduled === "function") {
      return worker.scheduled(event, env, ctx);
    }
  },
};
