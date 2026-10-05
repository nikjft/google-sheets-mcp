/**
 * gas-proxy — Generic Cloudflare Worker proxy for Google Apps Script web apps.
 *
 * WHY: Google Apps Script returns a 302 redirect on every request. The redirect
 * target (script.googleusercontent.com) only accepts GET. Standard HTTP clients
 * that preserve POST through a 302 (or Claude's MCP connector probe) get a 405
 * or a Google Drive "Page Not Found" page, which breaks MCP handshakes.
 *
 * HOW: This Worker sits in front of GAS. It POSTs to GAS, receives the 302,
 * follows the redirect as a GET (standard 302 behavior), and returns the real
 * JSON response to the caller.
 *
 * USAGE:
 *   https://<worker>.workers.dev/<DEPLOYMENT_ID>/exec[?apiKey=...]
 *
 *   - The path after the worker origin is forwarded verbatim to
 *     https://script.google.com/macros/s/<path>
 *   - Query parameters (including apiKey) are preserved.
 *   - Works for GET, POST, OPTIONS (CORS preflight).
 *   - Deploy once, reuse for any GAS project.
 */

export default {
  async fetch(request, env, ctx) {
    // --- CORS preflight ---
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // --- Build target URL ---
    const url = new URL(request.url);
    let gasPath = url.pathname.replace(/^\/+/, ""); // strip leading slash(es)

    // If path is empty, root, or just "exec", use default deployment ID
    if (!gasPath || gasPath === "exec" || gasPath === "/") {
      const defaultDep =
        (env && env.DEFAULT_DEPLOYMENT_ID) ||
        "AKfycbzY8JgYGAZh4bxDomemDZHde5x_TuUdZRH7f1DA43u0tcCoa-jjy0Rt5Tc1SjknvaU6";
      gasPath = `${defaultDep}/exec`;
    }

    // Strip optional "macros/s/" if present in path
    gasPath = gasPath.replace(/^macros\/s\//, "");

    // Ensure /exec is present if just deployment ID was given
    if (!gasPath.includes("/")) {
      gasPath = `${gasPath}/exec`;
    }

    const targetUrl = new URL(`https://script.google.com/macros/s/${gasPath}`);
    
    // Copy incoming query params
    for (const [k, v] of url.searchParams) {
      targetUrl.searchParams.set(k, v);
    }

    // Extract auth token from Authorization header or x-api-key if not already in query params
    if (
      !targetUrl.searchParams.has("apiKey") &&
      !targetUrl.searchParams.has("key") &&
      !targetUrl.searchParams.has("token")
    ) {
      const authHeader =
        request.headers.get("authorization") ||
        request.headers.get("Authorization");
      if (authHeader) {
        const match = authHeader.match(/^Bearer\s+(.+)$/i);
        const token = match ? match[1].trim() : authHeader.trim();
        if (token) {
          targetUrl.searchParams.set("apiKey", token);
        }
      }
      const xApiKey =
        request.headers.get("x-api-key") || request.headers.get("X-API-Key");
      if (xApiKey && !targetUrl.searchParams.has("apiKey")) {
        targetUrl.searchParams.set("apiKey", xApiKey.trim());
      }
      // If configured in Cloudflare Worker env (e.g. env.API_KEY)
      if (env && env.API_KEY && !targetUrl.searchParams.has("apiKey")) {
        targetUrl.searchParams.set("apiKey", env.API_KEY.trim());
      }
    }

    try {
      // --- Forward the request to GAS ---
      // redirect: "follow" (the default) converts POST→GET on 302,
      // which is exactly what GAS needs — the response is served at
      // the redirect target as a GET-only resource.
      const gasResponse = await fetch(targetUrl, {
        method: request.method,
        headers: filterHeaders(request.headers),
        body: request.method !== "GET" && request.method !== "HEAD"
          ? await request.arrayBuffer()
          : undefined,
        redirect: "follow",
      });

      // --- Return the response with CORS headers ---
      const responseBody = await gasResponse.text();
      const responseHeaders = new Headers();
      
      // Copy over safe headers from GAS
      for (const [key, value] of gasResponse.headers) {
        const lk = key.toLowerCase();
        // Skip hop-by-hop and encoding headers since text() decoded the body
        if (
          lk === "content-encoding" ||
          lk === "content-length" ||
          lk === "transfer-encoding"
        ) {
          continue;
        }
        responseHeaders.set(key, value);
      }

      // Add CORS headers
      for (const [key, value] of Object.entries(corsHeaders())) {
        responseHeaders.set(key, value);
      }

      return new Response(responseBody, {
        status: gasResponse.status,
        headers: responseHeaders,
      });
    } catch (err) {
      return jsonResponse(
        { error: "Proxy error", message: err.message },
        502
      );
    }
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, x-api-key, Accept",
    "Access-Control-Max-Age": "86400",
  };
}

function filterHeaders(headers) {
  // Forward relevant headers; skip host/cf-specific ones
  const forwarded = new Headers();
  for (const [key, value] of headers) {
    const lk = key.toLowerCase();
    if (
      lk === "host" ||
      lk.startsWith("cf-") ||
      lk === "x-forwarded-for" ||
      lk === "x-real-ip"
    ) {
      continue;
    }
    forwarded.set(key, value);
  }
  return forwarded;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}
