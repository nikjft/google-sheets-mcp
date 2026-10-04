# Objective: 

Build a generic MCP server in Google Apps Script (GAS) to interact with a specific spreadsheet, turning it into a generic MCP data source.

---

# Architecture & Design Decisions

### 1. Protocol Architecture
- **Standard MCP Protocol**: Implemented over HTTP via JSON-RPC 2.0 (compatible with MCP Protocol Version `2024-11-05`).
  - Supports standard RPC methods: `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call`.
  - Conforms to standard error codes (`-32700`, `-32600`, `-32601`, `-32602`, `-32603`).
  - Tool execution errors are returned inside the standard tool result format (`{ content: [...], isError: true }`).
- **REST & Query Fallback**: To facilitate debugging, browser inspection, and webhook integration, `doGet` and `doPost` also accept REST query payloads:
  - GET: `?action=list_sheets` or `?action=get_sheet_schema&sheetName=Companies`
  - POST: `{ "action": "get_sheet_contents", "arguments": { "sheetName": "Companies" } }`
- **Interactive Web Dashboard**: Navigating to the deployed Web App URL directly in a browser renders an interactive status dashboard showing target spreadsheet info, active tools, schemas, and connection guides.

### 2. Spreadsheet Targeting Hierarchy
The MCP server determines the active spreadsheet using the following resolution chain:
1. `spreadsheetId` parameter passed explicitly in the tool argument.
2. `SPREADSHEET_ID` property saved in `PropertiesService.getScriptProperties()`.
3. `SpreadsheetApp.getActiveSpreadsheet()` if the script is container-bound.
4. Default fallback spreadsheet: `1_hF1xS9rD29zUfm3o8eNV84WS8IfWfHTbwefUkuAXvw` (Companies & Contacts database).

### 3. Concurrency & Integrity
- All write operations (`insert_row`, `update_row`, `delete_row`, `setup_sheet_system_columns`) acquire a script lock via `LockService.getScriptLock()` with a timeout to prevent race conditions during concurrent tool executions.

---

### 4. Token-Efficiency & Large Payload Management
To maximize LLM context window efficiency and prevent bloated payloads:
- **Zero-Calculation End-of-Content Inserts**: Callers do not need to calculate or provide row numbers for inserting. `insert_row` automatically detects the last populated row and appends directly after it.
- **Column Projection (`columns`)**: In `get_sheet_contents`, `get_filtered_sheet_contents`, and `get_row`, clients can pass an array of column names (e.g. `["Company ID", "Company Name"]`). Unrequested columns are omitted completely, dramatically slashing token usage when scanning or building indexes.
- **Cell Length Truncation (`maxCellLength`)**: Large content blocks (notes, email bodies, HTML, transcripts) can be truncated to a character threshold (e.g. `maxCellLength: 100`). Truncated values include length previews (`... [truncated, 1200 chars]`).
- **One-Off Full Row Inspections (`get_row`)**: `get_row` returns complete, untruncated row data on-demand by UID or row number, enabling a token-efficient "index scan first, fetch full details on-demand" workflow.
- **Sparse Key Trimming (`omitEmpty`)**: When enabled, empty string and null columns are stripped from row objects, saving substantial tokens on sparse sheets.
- **Compact 2D Format (`format: "compact"`)**: Supports returning `{ headers: [...], rows: [[...]] }` to eliminate the token overhead of repeating JSON keys across dozens or hundreds of rows.
- **Concise Mutation Confirmations**: `insert_row` and `update_row` return lightweight confirmation objects (`{ success: true, rowNumber, assignedId, message }`) by default unless `returnFullRow: true` is explicitly requested.

---

# Implemented MCP Tools & Schemas

### 1. `list_sheets`
- **Description**: Enumerates all sheets/tabs in the spreadsheet with metadata (name, sheetId, index, rowCount, columnCount, isHidden).
- **Parameters**:
  - `spreadsheetId` *(optional, string)*

### 2. `get_sheet_schema`
- **Description**: Inspects column headers, letters, indexes, dimensions, and auto-detects UID, Created At, and Updated At columns.
- **Parameters**:
  - `sheetName` *(required, string)*
  - `spreadsheetId` *(optional, string)*
  - `headerRow` *(optional, number, default: 1)*
  - `idColumn` *(optional, string)*: Specify a custom column to treat as record UID.

### 3. `get_sheet_contents`
- **Description**: Returns rows mapped to header keys. Supports column projection, length truncation, and compact 2D format for maximum token efficiency.
- **Parameters**:
  - `sheetName` *(required, string)*
  - `spreadsheetId` *(optional, string)*
  - `columns` *(optional, string[])*: List of specific columns to project (e.g. `["Company ID", "Company Name"]`).
  - `maxCellLength` *(optional, number)*: Max character length before truncating long content blocks (e.g. `100`).
  - `omitEmpty` *(optional, boolean)*: Omit empty/null fields from row objects (default: `false`).
  - `format` *(optional, string)*: `"objects"` (default) or `"compact"` (2D array with headers once).
  - `valueRenderOption` *(optional, string)*: `"FORMATTED_VALUE"` (default), `"UNFORMATTED_VALUE"`, or `"FORMULA"`.
  - `limit` *(optional, number, default: 100, max: 1000)*
  - `offset` *(optional, number, default: 0)*
  - `includeRowNumber` *(optional, boolean, default: true)*: Includes `_rowNumber` in results.
  - `headerRow` *(optional, number, default: 1)*

### 4. `get_filtered_sheet_contents`
- **Description**: Filters rows matching specific column conditions. Evaluates full untruncated values and returns projected/truncated results for token efficiency.
- **Parameters**:
  - `sheetName` *(required, string)*
  - `filters` *(required, object or array)*:
    - Object format: `{"Industry": "Technology", "State": "CA"}`
    - Array format: `[{"column": "Company Size", "operator": ">=", "value": 50}]`
    - Supported operators: `eq`, `ne`, `contains`, `not_contains`, `starts_with`, `ends_with`, `gt`, `gte`, `lt`, `lte`, `in`, `is_empty`, `is_not_empty`.
  - `columns` *(optional, string[])*: Specific columns to project in results.
  - `maxCellLength` *(optional, number)*: Max character threshold for text cells.
  - `omitEmpty` *(optional, boolean)*: Omit empty/null fields.
  - `format` *(optional, string)*: `"objects"` or `"compact"`.
  - `matchAll` *(optional, boolean, default: true)*: `true` for AND condition, `false` for OR.
  - `valueRenderOption`, `limit`, `offset`, `includeRowNumber`, `headerRow`, `spreadsheetId` *(optional)*.

### 5. `get_row`
- **Description**: Fetch a single full row by UID or 1-based row number. Returns full untruncated content by default for one-off inspection of index entries.
- **Parameters**:
  - `sheetName` *(required, string)*
  - `rowIdentifier` *(required, object)*: `{"uid": "CMP-1001"}` or `{"rowNumber": 2}`.
  - `columns` *(optional, string[])*: Specific columns to retrieve.
  - `maxCellLength` *(optional, number)*: Defaults to null (full untruncated content).
  - `valueRenderOption`, `headerRow`, `spreadsheetId` *(optional)*.

### 6. `insert_row`
- **Description**: Inserts a new row mapped to column headers. Automatically finds the end of contents and appends without requiring a row number or position.
  - Automatically generates a UUID for the UID column if present and not provided.
  - Automatically timestamps `created_at` and `updated_at` columns if present.
  - Supports inserting formulas (strings starting with `=`).
  - Returns concise confirmation by default to conserve tokens.
- **Parameters**:
  - `sheetName` *(required, string)*
  - `data` *(required, object)*: Column key-value pairs.
  - `position` *(optional, string|number)*: Defaults to `"append"` (auto-detects end of content).
  - `returnFullRow` *(optional, boolean)*: If `true`, returns the complete inserted record. Defaults to `false` (concise confirmation).
  - `idColumn`, `spreadsheetId`, `headerRow` *(optional)*.

### 7. `update_row`
- **Description**: Updates existing row(s) identified by UID, row number, or column criteria (e.g. `column: "name", value: "bob"`). When matched by column, updates **ALL matching rows**.
  - Performs partial update (leaves unspecified columns untouched).
  - Supports formula strings (e.g. `{"=SUM(A2:B2)"}`).
  - Automatically updates the `updated_at` / `Edited Date` column timestamp.
  - Returns concise confirmation by default (`{ success: true, rowsUpdated: N, updatedRowNumbers: [...] }`).
- **Parameters**:
  - `sheetName` *(required, string)*
  - `rowIdentifier` *(required, object)*:
    - Column match: `{"column": "name", "value": "bob"}` (updates all rows where `name` equals `"bob"`).
    - UID match: `{"uid": "CMP-1001"}`.
    - Row number match: `{"rowNumber": 2}`.
  - `data` *(required, object)*: Fields to update.
  - `returnFullRow` *(optional, boolean)*: If `true`, returns the complete updated record(s). Defaults to `false`.
  - `spreadsheetId`, `headerRow` *(optional)*.

### 8. `delete_row`
- **Description**: Deletes row(s) by UID, row number, or column criteria (e.g. `column: "name", value: "bob"`). When matched by column, deletes **ALL matching rows** from bottom to top to preserve index integrity.
- **Parameters**:
  - `sheetName` *(required, string)*
  - `rowIdentifier` *(required, object)*:
    - Column match: `{"column": "name", "value": "bob"}` (deletes all rows where `name` equals `"bob"`).
    - UID match: `{"uid": "CMP-1001"}`.
    - Row number match: `{"rowNumber": 2}`.
  - `spreadsheetId`, `headerRow` *(optional)*.

### 9. `setup_sheet_system_columns`
- **Description**: Automatically prepares a sheet for persistent entity management by adding `_uid`, `_created_at`, and `_updated_at` columns if missing, and backfilling existing rows with unique IDs and timestamps.
- **Parameters**:
  - `sheetName` *(required, string)*
  - `idColumnName` *(optional, default: "_uid")*
  - `createdAtColumnName` *(optional, default: "_created_at")*
  - `updatedAtColumnName` *(optional, default: "_updated_at")*
  - `idPrefix` *(optional, default: "rec_")*
  - `spreadsheetId`, `headerRow` *(optional)*.

---

# Security & Authentication

1. **OAuth Compatibility**:
   - Deployed with Google account execution context.
   - For internal domain use (e.g., Google Workspace, Gemini Spark), user identity is authenticated by Google (`Session.getActiveUser().getEmail()`).
2. **API Key / Secret Token (Bearer & Query)**:
   - When an `API_KEY` is configured in Script Properties (`PropertiesService.getScriptProperties().setProperty("API_KEY", "...")`), all incoming requests must supply this key via:
     - Header: `Authorization: Bearer <TOKEN>` or `x-api-key: <TOKEN>`
     - Query parameter: `?apiKey=<TOKEN>` or `?token=<TOKEN>`
     - Payload body: `{ "apiKey": "<TOKEN>" }`
   - If no `API_KEY` is configured in Script Properties, the server operates in open/domain access mode.
   - Convenience admin helper functions available in code: `setApiKey(key)` and `clearApiKey()`.

---

# Google Sheets UI Integration (In-Sheet Menu & Dialogs)

To simplify setup, onboarding, key rotation, and maintenance directly from the spreadsheet interface, a custom menu `🤖 MCP Server` is added upon document load (`onOpen`):

### 1. `🚀 Run Diagnostics & Test Auth` (`menuRunDiagnostics`)
- Exercises the permissions grant on `SpreadsheetApp`.
- Validates access to all spreadsheet tabs and verifies sheet dimensions.
- Tests JSON-RPC tool router registration.
- Displays an in-sheet modal dialog with real-time health checks, tool counts, and deployment status.

### 2. `🔑 View / Copy API Key` (`menuShowApiKey`)
- Displays the currently configured `API_KEY` with one-click copy buttons for both the key and the Web App deployment URL.
- If no key exists yet, automatically generates a secure 32-character key (`mcp_...`), saves it to `PropertiesService`, and presents it to the user.
- Provides a ready-to-run `cURL` command example.

### 3. `🔄 Re-generate API Key` (`menuRegenerateApiKey`)
- Prompts for confirmation to prevent accidental client disruption.
- Generates a new secure key, updates `ScriptProperties`, and displays the refreshed key dialog.

### 4. `🛠️ Setup System Columns` (`menuSetupSystemColumnsActiveSheet` & `menuSetupSystemColumnsAllSheets`)
- Allows the user to select either the active sheet or all sheets.
- Automatically adds `_uid`, `_created_at`, and `_updated_at` columns if missing.
- Backfills existing data rows with unique IDs and ISO timestamps.
- Displays a confirmation summary dialog with the number of columns added and rows backfilled.

### 5. `📖 Documentation & Connection Guide` (`menuShowDocumentation`)
- Opens an interactive reference modal directly inside the spreadsheet.
- Provides copyable client configuration templates for Claude Desktop, Cursor, Gemini Spark, and HTTP proxy.
- Lists all 9 registered MCP tools with parameter documentation.

### 6. Automatic In-Sheet `onEdit(e)` Trigger
- **Selective Activation**: ONLY runs if `_uid`, `_created_at`, or `_updated_at` columns exist on the edited sheet. Updates all system columns that do exist:
  - If `_uid` exists and the edited row has an empty UID: automatically generates a persistent unique ID (`rec_...`).
  - If `_created_at` exists and the edited row has an empty created timestamp: sets current ISO timestamp.
  - If `_updated_at` exists: sets current ISO timestamp on every edit.
- Ignores edits to the header row and edits made to empty rows.

---

# Development, Deployment & Testing Process

### Clasp Environment
- Script ID: `1e6lu5qfqCz56U94cWiEAyqRZBocewQB-eXRgNHW3-DWt9xGespAm7sAL`
- Connected Sheet: `https://docs.google.com/spreadsheets/d/1_hF1xS9rD29zUfm3o8eNV84WS8IfWfHTbwefUkuAXvw/edit?gid=0#gid=0` (Tabs: `Companies`, `Contacts`)

### Deployment Workflow
1. **Push Changes**:
   ```bash
   npx @google/clasp push -f
   ```
2. **Create / Redeploy Web App**:
   ```bash
   npx @google/clasp deploy -i AKfycbwKVDlVHfxodkuLXYgvwMvjyDsRQB_pzT14QSjgKOgxwhkhYV2SNywIxLITqztvwa0m -d "Add onEdit in-sheet trigger and multi-row column matching update/delete"
   ```
   - Current Deployment ID: `AKfycbwKVDlVHfxodkuLXYgvwMvjyDsRQB_pzT14QSjgKOgxwhkhYV2SNywIxLITqztvwa0m @4`
   - Web App URL: `https://script.google.com/macros/s/AKfycbwKVDlVHfxodkuLXYgvwMvjyDsRQB_pzT14QSjgKOgxwhkhYV2SNywIxLITqztvwa0m/exec`

### Diagnostic Test Suite
- Built-in self-test function `testMCP()` runs directly in Apps Script to validate:
  1. `list_sheets` on target sheet
  2. `get_sheet_schema` on `Companies`
  3. `get_sheet_contents`
  4. `get_filtered_sheet_contents` with condition filters
  5. JSON-RPC `initialize` and `tools/list` handlers


