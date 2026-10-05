# Google Sheets MCP Server

Turn any Google Sheet into a Model Context Protocol (MCP) data source for LLMs like Claude, Cursor, and Gemini.

Built as a lightweight Google Apps Script Web App that implements the standard **JSON-RPC 2.0 MCP Protocol** (`2024-11-05`), allowing AI assistants to inspect sheet schemas, query with filtering and column projection, insert rows with auto-generated UUIDs, and update or delete rows.

---

## Features

- **No external hosting required**: Runs directly in Google Apps Script with access to your spreadsheet.
- **Claude & MCP Client Ready**:
  - **Claude.ai Custom Connectors**: Connect via Streamable HTTP (supports "No sign-in required" Open Mode).
  - **Claude Desktop / Cursor**: Connect via `mcp-proxy` or direct HTTP JSON-RPC.
- **In-Sheet Management (`🤖 MCP Server` Menu)**:
  - Setup Tracking Columns (`_uid`, `_updated_at`, `_created_at`) via an interactive wizard or one-click tools.
  - Automatic `onEdit` trigger maintains UUIDs and timestamps when rows are edited manually in the sheet.
  - One-click copy for authenticated URLs and API key management.
- **Token-Efficient by Design**:
  - **Column projection (`columns`)**: Request only needed columns.
  - **Length truncation (`maxCellLength`)**: Truncate long text to avoid blowing LLM context windows.
  - **Compact format**: Returns compact arrays instead of repeating JSON keys across rows.

---

## Quick Setup

### 1. Deploy via Clasp

Clone this repository and push to your Google Apps Script project:

```bash
git clone https://github.com/nikjft/google-sheets-mcp.git
cd google-sheets-mcp

# Login and configure your script ID in .clasp.json
clasp login
# Set "scriptId": "<YOUR_SCRIPT_ID>" in .clasp.json

clasp push
clasp deploy -d "Deploy Google Sheets MCP"
```

### 2. Configure Web App Deployment

1. Open your Google Sheet and go to **Extensions** > **Apps Script**.
2. Click **Deploy** > **Manage deployments**.
3. Edit the Web App deployment and set:
   - **Execute as**: `Me (<your-email>)`
   - **Who has access**: `Anyone` *(required so MCP clients can reach the endpoint)*
4. Copy your **Web App URL** (`https://script.google.com/macros/s/.../exec`).

---

## Connecting to Claude

### Claude.ai (Web Custom Connector)

> [!IMPORTANT]
> Google Apps Script web apps return a **302 redirect** on every request. The redirect target only accepts GET, which breaks Claude's POST-based MCP handshake. You need the included **`gas-proxy`** Cloudflare Worker (or similar proxy) to bridge this gap.

#### 1. Deploy the Proxy

```bash
cd gas-proxy
npm install
npx wrangler login     # one-time Cloudflare auth
npx wrangler deploy    # deploys to *.workers.dev
```

This gives you a URL like `https://gas-proxy.<your-subdomain>.workers.dev`. This single proxy works for **any** GAS web app — just change the deployment ID in the path.

#### 2. Connect Claude

1. In your Google Sheet, open **🤖 MCP Server** > **🔑 View / Manage Auth & API Key**.
2. Confirm the server is in **Open Access Mode (No Sign-in Required)** (or click **Switch to Open Mode**).
3. In Claude.ai:
   - Go to **Settings** > **Connectors** > **Add Custom Connector**.
   - **URL**: `https://gas-proxy.<your-subdomain>.workers.dev/<DEPLOYMENT_ID>/exec`
   - **Authentication**: Select **No sign-in required**.
   - Click **Add**.

*To use an API key instead, append `?apiKey=YOUR_KEY` to the proxy URL.*

#### Why a Proxy?

GAS responds to every POST with a `302 → script.googleusercontent.com` redirect. That redirect target **only accepts GET** and serves a Google Drive "Page Not Found" page for POST requests. Claude sees this as a 404 and reports: *"the server asked for sign-in when checked (status 404)"*. The proxy follows the redirect correctly and returns the real response.

### Claude Desktop / Cursor

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "google-sheets": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-proxy",
        "--transport",
        "http",
        "https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec?apiKey=<YOUR_API_KEY>"
      ]
    }
  }
}
```

---

## In-Sheet UI (`🤖 MCP Server` Menu)

Reloading your Google Sheet adds the **`🤖 MCP Server`** menu:

```text
🤖 MCP Server
├── 🚀 Run Diagnostics & Test Auth
├── ✨ Setup Sheet Tracking Wizard...
├── ➕ Add All Tracking Columns (_uid, _updated_at, _created_at)
├── ⚙️ Individual Column Tools ▸
│   ├── 🆔 Add UID Column (_uid)
│   ├── 🕒 Add Updated At Column (_updated_at)
│   ├── 📅 Add Created At Column (_created_at)
│   ├── 🔄 Backfill Missing UIDs Only
│   ├── ⏱️ Backfill Missing Timestamps Only
│   └── 🌐 Setup System Columns on ALL Sheets
├── 🔓 Switch to Open Mode (No Sign-in Required)
├── 🔑 View / Manage Auth & API Key
├── 🔄 Re-generate API Key
└── 📖 Documentation & Connection Guide
```

- **Setup Wizard**: Choose columns (`_uid`, `_updated_at`, `_created_at`), custom prefixes (`rec_`), and backfill options.
- **Auto-Sync on Edit**: Edits to any row automatically populate missing UIDs and update the `_updated_at` timestamp.
- **Auth Management**: View standalone API keys or copy pre-formatted authenticated URLs.

---

## Available MCP Tools

| Tool | Description | Key Parameters |
| --- | --- | --- |
| `list_sheets` | List all tabs with row/column counts and metadata | `spreadsheetId` (optional) |
| `get_sheet_schema` | Inspect headers, detected UID/timestamp columns, dimensions | `sheetName`, `headerRow` |
| `get_sheet_contents` | Read rows mapped to column headers with pagination | `sheetName`, `columns`, `limit`, `offset`, `maxCellLength` |
| `get_filtered_sheet_contents` | Filter rows by column criteria (eq, contains, gt, etc.) | `sheetName`, `filters`, `columns`, `matchAll` |
| `get_row` | Fetch a single full row by UID or 1-based row number | `sheetName`, `rowIdentifier` (`{"uid": "..."}` or `{"rowNumber": 2}`) |
| `insert_row` | Append a new row; auto-generates UUIDs and timestamps | `sheetName`, `data` (`{"Column": "Value"}`), `returnFullRow` |
| `update_row` | Update row(s) matching UID, row number, or column value | `sheetName`, `rowIdentifier`, `data` |
| `delete_row` | Delete row(s) matching UID, row number, or column value | `sheetName`, `rowIdentifier` |
| `setup_sheet_system_columns` | Programmatically add system columns and backfill rows | `sheetName`, `idColumnName`, `createdAtColumnName`, `updatedAtColumnName` |

---

## Authentication Modes

- **Open Mode (Recommended for Claude.ai)**: No token required. Google Apps Script serves requests directly.
- **API Key Mode**: Requires the key via header (`Authorization: Bearer <KEY>` or `x-api-key: <KEY>`) or query parameter (`?apiKey=<KEY>`).
