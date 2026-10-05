# gas-proxy

A generic Cloudflare Worker that proxies requests to **any** Google Apps Script web app, fixing the POST 302 redirect issue that breaks MCP clients like Claude.

## The Problem

Google Apps Script web apps return a `302 redirect` on every request. The redirect target (`script.googleusercontent.com`) only accepts GET. When MCP clients like Claude POST a JSON-RPC `initialize` request, the POST body is lost during the redirect, resulting in a 404/405 error that Claude reports as:

> *"server asked for sign-in when checked (status 404)"*

## The Fix

This Worker sits between the MCP client and GAS. It:
1. Receives the POST from Claude
2. Forwards it to GAS
3. Follows the 302 redirect as a GET (per HTTP spec)
4. Returns the real JSON response to Claude

## Setup

```bash
cd gas-proxy
npm install
npx wrangler login     # one-time Cloudflare auth
npx wrangler deploy    # deploys to *.workers.dev
```

## Usage

Replace the GAS URL in your MCP connector configuration:

```
# Instead of:
https://script.google.com/macros/s/AKfycb.../exec

# Use:
https://gas-proxy.<your-subdomain>.workers.dev/AKfycb.../exec
```

Query parameters like `?apiKey=...` are passed through automatically.

Works with **any** GAS web app — just swap the deployment ID in the path.

## Claude.ai Custom Connector

1. Deploy this Worker
2. In Claude → Settings → Connectors → Add Custom Connector
3. **URL**: `https://gas-proxy.<your-subdomain>.workers.dev/<DEPLOYMENT_ID>/exec`
4. **Authentication**: "No sign-in required"
5. Done ✅

## Local Development

```bash
npm run dev   # starts local dev server on http://localhost:8787
```

## Free Tier

Cloudflare Workers free tier includes 100,000 requests/day — more than enough for MCP usage.
