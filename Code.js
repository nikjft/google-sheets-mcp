/**
 * Google Sheet MCP (Model Context Protocol) Server for Google Apps Script
 *
 * Exposes a Google Spreadsheet as an MCP data source supporting:
 * - JSON-RPC 2.0 MCP protocol (initialize, tools/list, tools/call, ping)
 * - Basic CRUD & Search operations per spec.md:
 *   1. list_sheets
 *   2. get_sheet_schema
 *   3. get_sheet_contents
 *   4. get_filtered_sheet_contents
 *   5. insert_row
 *   6. update_row
 *   7. delete_row
 *   8. setup_sheet_system_columns (auto UID, created_at, updated_at)
 *   9. get_row (single row lookup by UID or row number)
 * - Security: API Token / Bearer Token & Google OAuth compatible
 * - Interactive HTML dashboard & REST fallback on doGet/doPost
 */

// ============================================================================
// CONFIGURATION & CONSTANTS
// ============================================================================

const CONFIG = {
  PROTOCOL_VERSION: "2024-11-05",
  SERVER_NAME: "google-sheet-mcp",
  SERVER_VERSION: "1.0.0",
  DEFAULT_SPREADSHEET_ID: "1_hF1xS9rD29zUfm3o8eNV84WS8IfWfHTbwefUkuAXvw",
  DEFAULT_ID_COLUMNS: [
    "_uid",
    "uid",
    "id",
    "ID",
    "Company ID",
    "Contact ID"
  ],
  DEFAULT_CREATED_COLUMNS: [
    "_created_at",
    "created_at",
    "Created At",
    "Created Date",
    "CreatedAt"
  ],
  DEFAULT_UPDATED_COLUMNS: [
    "_updated_at",
    "updated_at",
    "Updated At",
    "Updated Date",
    "Edited Date",
    "UpdatedAt",
    "Last Modified"
  ]
};

// ============================================================================
// HTTP HANDLERS (Web App Entry Points)
// ============================================================================

/**
 * Handle HTTP GET requests
 * Supports:
 * - Interactive HTML status & tools documentation dashboard
 * - Direct REST API execution via query params (e.g. ?action=list_sheets)
 * - MCP JSON-RPC execution via ?jsonrpc=...
 */
function doGet(e) {
  try {
    const params = (e && e.parameter) ? e.parameter : {};
    const action = params.action || params.tool || params.method;

    // Administrative trigger to switch to open mode directly via URL
    if (action === "clear_api_key" || action === "open_mode") {
      PropertiesService.getScriptProperties().deleteProperty("API_KEY");
      return jsonResponse({
        success: true,
        authMode: "OPEN",
        message: "API key cleared. Open Mode (no sign-in required) is now active."
      });
    }

    // Check authentication for protected queries
    const authCheck = validateAuth(e, null);
    if (!authCheck.authorized && action && action !== "ping" && action !== "initialize" && action !== "tools/list") {
      return jsonResponse({
        error: "Unauthorized",
        message: authCheck.error
      }, 401);
    }

    // Direct REST query via action or tool parameter
    if (action) {
      if (action === "tools/list" || action === "list_tools") {
        return jsonResponse({ tools: getToolDefinitions() });
      }
      
      let parsedArgs = {};
      if (params.arguments) {
        try {
          parsedArgs = JSON.parse(params.arguments);
        } catch (err) {
          return jsonResponse({ error: "Invalid arguments JSON parameter" }, 400);
        }
      } else {
        parsedArgs = Object.assign({}, params);
        delete parsedArgs.action;
        delete parsedArgs.tool;
        delete parsedArgs.method;
        delete parsedArgs.apiKey;
        delete parsedArgs.key;
        delete parsedArgs.token;
      }

      const result = executeTool(action, parsedArgs);
      return jsonResponse({ success: true, action: action, result: result });
    }

    // Remote MCP Client Handshake (Claude, Cursor, Streamable HTTP GET)
    // If request comes with JSON-RPC or Accept header indicating API/event-stream, return MCP server handshake JSON
    const acceptHeader = (e && e.headers) ? (e.headers["Accept"] || e.headers["accept"] || "") : "";
    const isExplicitBrowser = acceptHeader.includes("text/html") && !acceptHeader.includes("application/json") && !acceptHeader.includes("text/event-stream");

    if (!isExplicitBrowser || params.jsonrpc) {
      return jsonResponse({
        jsonrpc: "2.0",
        result: {
          protocolVersion: CONFIG.PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false }
          },
          serverInfo: {
            name: CONFIG.SERVER_NAME,
            version: CONFIG.SERVER_VERSION
          },
          instructions: "Google Sheets MCP Server providing CRUD, search, and schema operations on Google Spreadsheets."
        }
      });
    }

    // Render interactive HTML dashboard if accessed via browser
    return renderDashboardHtml(params);
  } catch (error) {
    return jsonResponse({
      error: "Internal Server Error",
      message: error.toString(),
      stack: error.stack
    }, 500);
  }
}

/**
 * Handle HTTP POST requests
 * Supports:
 * - Standard JSON-RPC 2.0 MCP requests (initialize, tools/list, tools/call, ping)
 * - Batch JSON-RPC requests
 * - REST payload fallback ({ action: "...", arguments: {...} })
 */
function doPost(e) {
  try {
    let bodyText = "";
    if (e && e.postData && e.postData.contents) {
      bodyText = e.postData.contents;
    }

    if (!bodyText) {
      return jsonResponse({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error: Empty request body" }
      });
    }

    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch (parseErr) {
      return jsonResponse({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error: Invalid JSON: " + parseErr.message }
      });
    }

    // Allow MCP protocol discovery (initialize, ping, tools/list) without blocking on API key if client is probing
    const isProbe = payload && (
      payload.method === "initialize" ||
      payload.method === "ping" ||
      payload.method === "tools/list" ||
      payload.method === "notifications/initialized"
    );

    // Authentication verification
    const authCheck = validateAuth(e, payload);
    if (!authCheck.authorized && !isProbe) {
      return jsonResponse({
        jsonrpc: "2.0",
        id: (payload && payload.id !== undefined) ? payload.id : null,
        error: { code: -32000, message: authCheck.error }
      });
    }

    // Support JSON-RPC 2.0 batch requests
    if (Array.isArray(payload)) {
      const responses = payload.map(req => handleJsonRpcRequest(req));
      return jsonResponse(responses.filter(r => r !== null));
    }

    // Standard JSON-RPC 2.0 single request
    if (payload && payload.jsonrpc === "2.0") {
      const response = handleJsonRpcRequest(payload);
      return jsonResponse(response || {});
    }

    // REST fallback support: { action: "...", arguments: {...} }
    const action = payload.action || payload.tool;
    if (action) {
      const args = payload.arguments || payload.params || payload.data || {};
      const result = executeTool(action, args);
      return jsonResponse({ success: true, action: action, result: result });
    }

    // Default error for unhandled POST schema
    return jsonResponse({
      jsonrpc: "2.0",
      id: payload.id !== undefined ? payload.id : null,
      error: { code: -32600, message: "Invalid Request: Expected JSON-RPC 2.0 object or { action, arguments }" }
    });
  } catch (error) {
    return jsonResponse({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "Internal error: " + error.toString() }
    });
  }
}

// ============================================================================
// MCP JSON-RPC 2.0 PROTOCOL ROUTER
// ============================================================================

/**
 * Handle a single JSON-RPC 2.0 request
 */
function handleJsonRpcRequest(req) {
  if (!req || typeof req !== "object") {
    return {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" }
    };
  }

  const id = req.id !== undefined ? req.id : null;
  const method = req.method;
  const params = req.params || {};

  // Notifications (requests without id)
  const isNotification = (req.id === undefined);

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id: id,
        result: {
          protocolVersion: CONFIG.PROTOCOL_VERSION,
          capabilities: {
            tools: {
              listChanged: false
            }
          },
          serverInfo: {
            name: CONFIG.SERVER_NAME,
            version: CONFIG.SERVER_VERSION
          },
          instructions: "Google Sheets MCP Server providing CRUD, search, and schema operations on Google Spreadsheets."
        }
      };

    case "notifications/initialized":
      // Client confirms initialization. Notifications require no response.
      return isNotification ? null : { jsonrpc: "2.0", id: id, result: {} };

    case "ping":
      return {
        jsonrpc: "2.0",
        id: id,
        result: {}
      };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id: id,
        result: {
          tools: getToolDefinitions()
        }
      };

    case "tools/call": {
      const toolName = params.name;
      const toolArgs = params.arguments || {};

      if (!toolName) {
        return {
          jsonrpc: "2.0",
          id: id,
          error: { code: -32602, message: "Invalid params: 'name' is required for tools/call" }
        };
      }

      try {
        const toolResult = executeTool(toolName, toolArgs);
        return {
          jsonrpc: "2.0",
          id: id,
          result: {
            content: [
              {
                type: "text",
                text: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult, null, 2)
              }
            ],
            isError: false
          }
        };
      } catch (toolError) {
        return {
          jsonrpc: "2.0",
          id: id,
          result: {
            content: [
              {
                type: "text",
                text: "Error executing tool '" + toolName + "': " + (toolError.message || toolError.toString())
              }
            ],
            isError: true
          }
        };
      }
    }

    default:
      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id: id,
        error: { code: -32601, message: "Method not found: " + method }
      };
  }
}

// ============================================================================
// SECURITY & AUTHENTICATION
// ============================================================================

/**
 * Validate incoming request authentication
 * Checks Script Properties 'API_KEY'. If not set, allows open access.
 * Supports:
 * - Header 'Authorization: Bearer <TOKEN>'
 * - Header 'x-api-key: <TOKEN>'
 * - Query param ?apiKey=... or ?key=... or ?token=...
 * - Body payload apiKey or token
 */
function validateAuth(e, payload) {
  const configuredKey = PropertiesService.getScriptProperties().getProperty("API_KEY");

  // If no API_KEY is configured in Script Properties, permit requests
  if (!configuredKey) {
    return { authorized: true };
  }

  let clientToken = null;

  // 1. Check query parameters
  if (e && e.parameter) {
    clientToken = e.parameter.apiKey || e.parameter.key || e.parameter.token;
  }

  // 2. Check JSON payload
  if (!clientToken && payload && typeof payload === "object") {
    clientToken = payload.apiKey || payload.token;
  }

  // 3. Check HTTP headers (if available in Apps Script environment)
  if (!clientToken && e && e.headers) {
    const authHeader = e.headers["Authorization"] || e.headers["authorization"];
    if (authHeader) {
      if (authHeader.startsWith("Bearer ")) {
        clientToken = authHeader.substring(7).trim();
      } else {
        clientToken = authHeader.trim();
      }
    }
    if (!clientToken) {
      clientToken = e.headers["x-api-key"] || e.headers["X-API-Key"];
    }
  }

  if (clientToken && clientToken === configuredKey) {
    return { authorized: true };
  }

  return {
    authorized: false,
    error: "Unauthorized: Invalid or missing API key."
  };
}

/**
 * Helper to configure API key from GAS script editor
 */
function setApiKey(key) {
  PropertiesService.getScriptProperties().setProperty("API_KEY", key);
  Logger.log("API Key has been configured.");
}

/**
 * Helper to remove API key requirement
 */
function clearApiKey() {
  PropertiesService.getScriptProperties().deleteProperty("API_KEY");
  Logger.log("API Key cleared. Open access restored.");
}

/**
 * Helper to configure default Spreadsheet ID
 */
function setDefaultSpreadsheetId(sheetId) {
  PropertiesService.getScriptProperties().setProperty("SPREADSHEET_ID", sheetId);
  Logger.log("Default Spreadsheet ID set to: " + sheetId);
}

// ============================================================================
// MCP TOOL DEFINITIONS (JSON Schema)
// ============================================================================

function getToolDefinitions() {
  return [
    {
      name: "list_sheets",
      description: "List all sheet tabs in the spreadsheet with metadata (name, sheetId, index, rowCount, columnCount, isHidden).",
      inputSchema: {
        type: "object",
        properties: {
          spreadsheetId: {
            type: "string",
            description: "Optional spreadsheet ID. Defaults to configured spreadsheet."
          }
        }
      }
    },
    {
      name: "get_sheet_schema",
      description: "Get column schema, headers, detected UID/timestamp columns, and dimensions for a given sheet.",
      inputSchema: {
        type: "object",
        properties: {
          sheetName: {
            type: "string",
            description: "Name of the sheet tab."
          },
          spreadsheetId: {
            type: "string",
            description: "Optional spreadsheet ID."
          },
          headerRow: {
            type: "number",
            description: "1-based row index containing column headers (default: 1)."
          },
          idColumn: {
            type: "string",
            description: "Optional name of custom column to treat as unique record ID."
          }
        },
        required: ["sheetName"]
      }
    },
    {
      name: "get_sheet_contents",
      description: "Return rows of a sheet as JSON objects according to header schema. Supports column projection, length truncation, and compact formats for maximum token efficiency.",
      inputSchema: {
        type: "object",
        properties: {
          sheetName: {
            type: "string",
            description: "Name of the sheet tab."
          },
          spreadsheetId: {
            type: "string",
            description: "Optional spreadsheet ID."
          },
          columns: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of column names to project (e.g. ['Company ID', 'Company Name']). Drastically saves tokens when scanning or indexing large sheets."
          },
          maxCellLength: {
            type: "number",
            description: "Optional max character length for text cells (e.g. 100). Longer content blocks are truncated with preview. Use get_row for one-off full row inspection."
          },
          omitEmpty: {
            type: "boolean",
            description: "Optional. If true, omits empty/null fields from row objects to save tokens on sparse sheets (default: false)."
          },
          format: {
            type: "string",
            enum: ["objects", "compact"],
            description: "Output format: 'objects' (default) returns array of row objects. 'compact' returns { headers: [...], rows: [[...]] } which avoids repeating header keys on every row."
          },
          valueRenderOption: {
            type: "string",
            enum: ["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"],
            description: "FORMATTED_VALUE (default: formatted display string), UNFORMATTED_VALUE (raw numbers/booleans/dates), or FORMULA (formula expressions)."
          },
          limit: {
            type: "number",
            description: "Maximum number of rows to return (default: 100, max: 1000)."
          },
          offset: {
            type: "number",
            description: "Number of rows to skip after the header (default: 0)."
          },
          includeRowNumber: {
            type: "boolean",
            description: "Whether to include '_rowNumber' (1-based sheet row index) in each row object (default: true)."
          },
          headerRow: {
            type: "number",
            description: "1-based row index for headers (default: 1)."
          }
        },
        required: ["sheetName"]
      }
    },
    {
      name: "get_filtered_sheet_contents",
      description: "Return rows from a sheet filtered by column criteria. Supports column projection, cell length truncation, and compact formats for token efficiency.",
      inputSchema: {
        type: "object",
        properties: {
          sheetName: {
            type: "string",
            description: "Name of the sheet tab."
          },
          filters: {
            description: "Filter conditions. Can be a key-value object (e.g. {\"Industry\": \"Technology\"}) or an array of filter objects: [{\"column\": \"Company Size\", \"operator\": \">=\", \"value\": 50}].",
            type: ["object", "array"]
          },
          columns: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of column names to project. Drastically reduces token usage on matched rows."
          },
          maxCellLength: {
            type: "number",
            description: "Optional max character length for text cells (e.g. 100). Truncates long content blocks with preview."
          },
          omitEmpty: {
            type: "boolean",
            description: "If true, omits empty/null fields to save tokens (default: false)."
          },
          format: {
            type: "string",
            enum: ["objects", "compact"],
            description: "Output format: 'objects' (default) or 'compact' (headers array + 2D values array)."
          },
          matchAll: {
            type: "boolean",
            description: "If true (default), all filter conditions must match (AND). If false, any condition matching is returned (OR)."
          },
          spreadsheetId: {
            type: "string",
            description: "Optional spreadsheet ID."
          },
          valueRenderOption: {
            type: "string",
            enum: ["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"],
            description: "Value rendering mode (default: FORMATTED_VALUE)."
          },
          limit: {
            type: "number",
            description: "Maximum number of matched rows to return (default: 100)."
          },
          offset: {
            type: "number",
            description: "Number of matched rows to skip (default: 0)."
          },
          includeRowNumber: {
            type: "boolean",
            description: "Include '_rowNumber' in result objects (default: true)."
          },
          headerRow: {
            type: "number",
            description: "1-based row index for headers (default: 1)."
          }
        },
        required: ["sheetName", "filters"]
      }
    },
    {
      name: "get_row",
      description: "Retrieve a single full row by unique ID (UID) or 1-based row number. Returns full untruncated content by default.",
      inputSchema: {
        type: "object",
        properties: {
          sheetName: {
            type: "string",
            description: "Name of the sheet tab."
          },
          rowIdentifier: {
            type: "object",
            description: "Identifier object: { \"uid\": \"CMP-1001\" } or { \"rowNumber\": 2 }. Optionally include \"idColumn\": \"Company ID\".",
            properties: {
              uid: { type: "string" },
              rowNumber: { type: "number" },
              idColumn: { type: "string" }
            }
          },
          columns: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of specific columns to retrieve. If omitted, returns all columns in the row."
          },
          maxCellLength: {
            type: "number",
            description: "Optional max character length for text cells. Defaults to null (full untruncated content returned)."
          },
          spreadsheetId: {
            type: "string",
            description: "Optional spreadsheet ID."
          },
          valueRenderOption: {
            type: "string",
            enum: ["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"],
            description: "Value render option (default: FORMATTED_VALUE)."
          },
          headerRow: {
            type: "number",
            description: "1-based row index for headers (default: 1)."
          }
        },
        required: ["sheetName", "rowIdentifier"]
      }
    },
    {
      name: "insert_row",
      description: "Insert a new row into the sheet mapped to column headers. Automatically finds the end of contents and appends without requiring a row number or position. Automatically assigns a UID and sets created_at/updated_at timestamps if those columns exist.",
      inputSchema: {
        type: "object",
        properties: {
          sheetName: {
            type: "string",
            description: "Name of the sheet tab."
          },
          data: {
            type: "object",
            description: "Object mapping header names to values or formulas (strings starting with '=' are stored as formulas)."
          },
          position: {
            description: "Optional insertion position: 'append' (default - automatically finds end of contents), 'top' (after header), or specific row number.",
            type: ["string", "number"]
          },
          returnFullRow: {
            type: "boolean",
            description: "Optional. If false (default), returns a concise confirmation to save tokens. If true, returns full inserted row."
          },
          idColumn: {
            type: "string",
            description: "Optional column name to treat as unique ID. If not supplied in data, a UUID will be generated."
          },
          spreadsheetId: {
            type: "string",
            description: "Optional spreadsheet ID."
          },
          headerRow: {
            type: "number",
            description: "1-based row index for headers (default: 1)."
          }
        },
        required: ["sheetName", "data"]
      }
    },
    {
      name: "update_row",
      description: "Update existing row(s) by UID, row number, or column match (e.g. column: 'name', value: 'bob'). When matched by column, updates ALL matching rows. Supports partial updates, formulas, and auto-timestamps updated_at.",
      inputSchema: {
        type: "object",
        properties: {
          sheetName: {
            type: "string",
            description: "Name of the sheet tab."
          },
          rowIdentifier: {
            type: "object",
            description: "Criteria to identify row(s). Can be: { \"column\": \"name\", \"value\": \"bob\" } (matches ALL rows where column equals value), { \"uid\": \"CMP-1001\" }, or { \"rowNumber\": 2 }.",
            properties: {
              column: { type: "string", description: "Column name to match against (affects all matching rows)." },
              value: { description: "Value to match in the specified column." },
              operator: { type: "string", description: "Optional match operator: eq, contains, starts_with, gt, lt, etc. (default: eq)." },
              uid: { type: "string", description: "Unique ID of record to match." },
              idColumn: { type: "string", description: "Optional column name to treat as unique ID." },
              rowNumber: { type: "number", description: "1-based sheet row index." }
            }
          },
          data: {
            type: "object",
            description: "Key-value pairs of fields to update. Values starting with '=' are treated as formulas."
          },
          returnFullRow: {
            type: "boolean",
            description: "Optional. If false (default), returns concise confirmation to save tokens. If true, returns full updated row(s)."
          },
          spreadsheetId: {
            type: "string",
            description: "Optional spreadsheet ID."
          },
          headerRow: {
            type: "number",
            description: "1-based row index for headers (default: 1)."
          }
        },
        required: ["sheetName", "rowIdentifier", "data"]
      }
    },
    {
      name: "delete_row",
      description: "Delete row(s) from a sheet by UID, row number, or column match (e.g. column: 'name', value: 'bob'). When matched by column, deletes ALL matching rows.",
      inputSchema: {
        type: "object",
        properties: {
          sheetName: {
            type: "string",
            description: "Name of the sheet tab."
          },
          rowIdentifier: {
            type: "object",
            description: "Criteria to identify row(s). Can be: { \"column\": \"name\", \"value\": \"bob\" } (deletes ALL matching rows), { \"uid\": \"CMP-1001\" }, or { \"rowNumber\": 2 }.",
            properties: {
              column: { type: "string", description: "Column name to match against (deletes all matching rows)." },
              value: { description: "Value to match in the specified column." },
              operator: { type: "string", description: "Optional match operator: eq, contains, starts_with, gt, lt, etc. (default: eq)." },
              uid: { type: "string", description: "Unique ID of record to match." },
              idColumn: { type: "string", description: "Optional column name to treat as unique ID." },
              rowNumber: { type: "number", description: "1-based sheet row index." }
            }
          },
          spreadsheetId: {
            type: "string",
            description: "Optional spreadsheet ID."
          },
          headerRow: {
            type: "number",
            description: "1-based row index for headers (default: 1)."
          }
        },
        required: ["sheetName", "rowIdentifier"]
      }
    },
    {
      name: "setup_sheet_system_columns",
      description: "Automatically configure persistent system columns (_uid, _created_at, _updated_at) on a sheet and backfill existing rows.",
      inputSchema: {
        type: "object",
        properties: {
          sheetName: {
            type: "string",
            description: "Name of the sheet tab."
          },
          idColumnName: {
            type: "string",
            description: "Column name for unique ID (default: '_uid')."
          },
          createdAtColumnName: {
            type: "string",
            description: "Column name for creation timestamp (default: '_created_at')."
          },
          updatedAtColumnName: {
            type: "string",
            description: "Column name for update timestamp (default: '_updated_at')."
          },
          idPrefix: {
            type: "string",
            description: "Prefix for generated IDs (default: 'rec_')."
          },
          spreadsheetId: {
            type: "string",
            description: "Optional spreadsheet ID."
          },
          headerRow: {
            type: "number",
            description: "1-based row index for headers (default: 1)."
          }
        },
        required: ["sheetName"]
      }
    }
  ];
}

// ============================================================================
// TOOL EXECUTION ROUTER
// ============================================================================

function executeTool(toolName, args) {
  args = args || {};

  switch (toolName) {
    case "list_sheets":
      return toolListSheets(args);

    case "get_sheet_schema":
      return toolGetSheetSchema(args);

    case "get_sheet_contents":
      return toolGetSheetContents(args);

    case "get_filtered_sheet_contents":
      return toolGetFilteredSheetContents(args);

    case "get_row":
      return toolGetRow(args);

    case "insert_row":
      return toolInsertRow(args);

    case "update_row":
      return toolUpdateRow(args);

    case "delete_row":
      return toolDeleteRow(args);

    case "setup_sheet_system_columns":
      return toolSetupSheetSystemColumns(args);

    default:
      throw new Error("Unknown tool: " + toolName);
  }
}

// ============================================================================
// CORE SPREADSHEET TOOL IMPLEMENTATIONS
// ============================================================================

/**
 * Tool: list_sheets
 */
function toolListSheets(args) {
  const ss = getSpreadsheet(args.spreadsheetId);
  const sheets = ss.getSheets();

  const sheetList = sheets.map((sheet, index) => {
    return {
      name: sheet.getName(),
      sheetId: sheet.getSheetId(),
      index: index,
      rowCount: sheet.getMaxRows(),
      columnCount: sheet.getMaxColumns(),
      lastRow: sheet.getLastRow(),
      lastColumn: sheet.getLastColumn(),
      isHidden: sheet.isSheetHidden()
    };
  });

  return {
    spreadsheetId: ss.getId(),
    spreadsheetName: ss.getName(),
    totalSheets: sheetList.length,
    sheets: sheetList
  };
}

/**
 * Tool: get_sheet_schema
 */
function toolGetSheetSchema(args) {
  if (!args.sheetName) throw new Error("Missing required argument: 'sheetName'");

  const ss = getSpreadsheet(args.spreadsheetId);
  const sheet = getSheetOrThrow(ss, args.sheetName);
  const headerRowIndex = Number(args.headerRow) || 1;

  const lastCol = sheet.getLastColumn();
  const lastRow = sheet.getLastRow();

  if (lastCol === 0 || lastRow < headerRowIndex) {
    return {
      sheetName: sheet.getName(),
      headerRow: headerRowIndex,
      dataRows: 0,
      totalColumns: 0,
      headers: [],
      detectedIdColumn: null,
      detectedCreatedAtColumn: null,
      detectedUpdatedAtColumn: null
    };
  }

  const rawHeaders = sheet.getRange(headerRowIndex, 1, 1, lastCol).getValues()[0];
  const headers = [];

  let detectedIdColumn = args.idColumn || null;
  let detectedCreatedAtColumn = null;
  let detectedUpdatedAtColumn = null;

  for (let i = 0; i < rawHeaders.length; i++) {
    const headerName = String(rawHeaders[i]).trim();
    if (!headerName) continue;

    const colIndex = i + 1;
    const colLetter = indexToColumnLetter(colIndex);

    const isId = isMatchColumn(headerName, args.idColumn ? [args.idColumn] : CONFIG.DEFAULT_ID_COLUMNS);
    const isCreated = isMatchColumn(headerName, CONFIG.DEFAULT_CREATED_COLUMNS);
    const isUpdated = isMatchColumn(headerName, CONFIG.DEFAULT_UPDATED_COLUMNS);

    if (isId && !detectedIdColumn) detectedIdColumn = headerName;
    if (isCreated && !detectedCreatedAtColumn) detectedCreatedAtColumn = headerName;
    if (isUpdated && !detectedUpdatedAtColumn) detectedUpdatedAtColumn = headerName;

    headers.push({
      name: headerName,
      columnIndex: colIndex,
      columnLetter: colLetter,
      isIdColumn: isId,
      isCreatedAtColumn: isCreated,
      isUpdatedAtColumn: isUpdated
    });
  }

  return {
    spreadsheetId: ss.getId(),
    sheetName: sheet.getName(),
    headerRow: headerRowIndex,
    dataRows: Math.max(0, lastRow - headerRowIndex),
    totalColumns: headers.length,
    headers: headers,
    detectedIdColumn: detectedIdColumn,
    detectedCreatedAtColumn: detectedCreatedAtColumn,
    detectedUpdatedAtColumn: detectedUpdatedAtColumn
  };
}

/**
 * Format a cell value with optional max length truncation
 */
function formatCellValue(val, maxCellLength) {
  if (val === null || val === undefined) return "";
  if (typeof val === "string" && maxCellLength && maxCellLength > 0 && val.length > maxCellLength) {
    return val.substring(0, maxCellLength) + "... [truncated, " + val.length + " chars]";
  }
  return val;
}

/**
 * Builds row objects or compact format rows with token-efficiency optimizations
 */
function buildRowRecords(rawValues, headerMap, startRowNumber, options) {
  options = options || {};
  const includeRowNumber = options.includeRowNumber !== false;
  const targetColumns = (Array.isArray(options.columns) && options.columns.length > 0)
    ? options.columns.map(c => String(c).trim().toLowerCase())
    : null;
  const maxCellLength = Number(options.maxCellLength) || null;
  const omitEmpty = options.omitEmpty === true;
  const format = options.format === "compact" ? "compact" : "objects";

  const filteredHeaders = headerMap.filter(h =>
    !targetColumns || targetColumns.includes(h.name.toLowerCase())
  );

  if (format === "compact") {
    const compactHeaders = filteredHeaders.map(h => h.name);
    if (includeRowNumber) compactHeaders.unshift("_rowNumber");

    const compactRows = [];
    for (let r = 0; r < rawValues.length; r++) {
      const rowItem = [];
      const currentRowNumber = startRowNumber + r;
      if (includeRowNumber) rowItem.push(currentRowNumber);

      const rowData = rawValues[r];
      for (const h of filteredHeaders) {
        let cellVal = (rowData[h.colIndex - 1] !== undefined) ? rowData[h.colIndex - 1] : "";
        cellVal = formatCellValue(cellVal, maxCellLength);
        rowItem.push(cellVal);
      }
      compactRows.push(rowItem);
    }

    return {
      format: "compact",
      headers: compactHeaders,
      rows: compactRows
    };
  }

  // Default: array of objects
  const rows = [];
  for (let r = 0; r < rawValues.length; r++) {
    const rowObj = {};
    const currentRowNumber = startRowNumber + r;
    if (includeRowNumber) {
      rowObj["_rowNumber"] = currentRowNumber;
    }

    const rowData = rawValues[r];
    for (const h of filteredHeaders) {
      let cellVal = (rowData[h.colIndex - 1] !== undefined) ? rowData[h.colIndex - 1] : "";
      cellVal = formatCellValue(cellVal, maxCellLength);

      if (omitEmpty && (cellVal === "" || cellVal === null || cellVal === undefined)) {
        continue;
      }
      rowObj[h.name] = cellVal;
    }
    rows.push(rowObj);
  }

  return {
    format: "objects",
    rows: rows
  };
}

/**
 * Tool: get_sheet_contents
 */
function toolGetSheetContents(args) {
  if (!args.sheetName) throw new Error("Missing required argument: 'sheetName'");

  const ss = getSpreadsheet(args.spreadsheetId);
  const sheet = getSheetOrThrow(ss, args.sheetName);
  const headerRowIndex = Number(args.headerRow) || 1;
  const renderOption = args.valueRenderOption || "FORMATTED_VALUE";
  const limit = Math.min(Math.max(1, Number(args.limit) || 100), 1000);
  const offset = Math.max(0, Number(args.offset) || 0);

  const lastCol = sheet.getLastColumn();
  const lastRow = sheet.getLastRow();

  if (lastCol === 0 || lastRow <= headerRowIndex) {
    return {
      sheetName: sheet.getName(),
      totalRows: 0,
      returnedRows: 0,
      offset: offset,
      limit: limit,
      rows: []
    };
  }

  const rawHeaders = sheet.getRange(headerRowIndex, 1, 1, lastCol).getValues()[0];
  const headerMap = mapHeaders(rawHeaders);

  const totalDataRows = lastRow - headerRowIndex;
  const startRow = headerRowIndex + 1 + offset;
  const numRowsToFetch = Math.min(limit, Math.max(0, lastRow - startRow + 1));

  if (numRowsToFetch <= 0) {
    return {
      sheetName: sheet.getName(),
      totalRows: totalDataRows,
      returnedRows: 0,
      offset: offset,
      limit: limit,
      rows: []
    };
  }

  const dataRange = sheet.getRange(startRow, 1, numRowsToFetch, lastCol);
  const rawValues = fetchRangeData(dataRange, renderOption);

  const recordResult = buildRowRecords(rawValues, headerMap, startRow, {
    columns: args.columns,
    maxCellLength: args.maxCellLength,
    omitEmpty: args.omitEmpty,
    format: args.format,
    includeRowNumber: args.includeRowNumber
  });

  const response = {
    sheetName: sheet.getName(),
    totalRows: totalDataRows,
    returnedRows: recordResult.rows.length,
    offset: offset,
    limit: limit
  };

  if (recordResult.format === "compact") {
    response.format = "compact";
    response.headers = recordResult.headers;
    response.rows = recordResult.rows;
  } else {
    response.rows = recordResult.rows;
  }

  return response;
}

/**
 * Tool: get_filtered_sheet_contents
 */
function toolGetFilteredSheetContents(args) {
  if (!args.sheetName) throw new Error("Missing required argument: 'sheetName'");
  if (!args.filters) throw new Error("Missing required argument: 'filters'");

  const ss = getSpreadsheet(args.spreadsheetId);
  const sheet = getSheetOrThrow(ss, args.sheetName);
  const headerRowIndex = Number(args.headerRow) || 1;
  const renderOption = args.valueRenderOption || "FORMATTED_VALUE";
  const limit = Math.min(Math.max(1, Number(args.limit) || 100), 1000);
  const offset = Math.max(0, Number(args.offset) || 0);
  const matchAll = args.matchAll !== false;

  const lastCol = sheet.getLastColumn();
  const lastRow = sheet.getLastRow();

  if (lastCol === 0 || lastRow <= headerRowIndex) {
    return {
      sheetName: sheet.getName(),
      totalMatched: 0,
      returnedRows: 0,
      offset: offset,
      limit: limit,
      rows: []
    };
  }

  const rawHeaders = sheet.getRange(headerRowIndex, 1, 1, lastCol).getValues()[0];
  const headerMap = mapHeaders(rawHeaders);
  const normalizedFilters = normalizeFilters(args.filters);

  const totalDataRows = lastRow - headerRowIndex;
  const dataRange = sheet.getRange(headerRowIndex + 1, 1, totalDataRows, lastCol);
  const rawValues = fetchRangeData(dataRange, renderOption);

  const matchedRawValues = [];
  const matchedRowNumbers = [];

  for (let r = 0; r < rawValues.length; r++) {
    const rowValues = rawValues[r];
    const currentRowNumber = headerRowIndex + 1 + r;

    // Full row record for filter evaluation
    const evalObj = { _rowNumber: currentRowNumber };
    for (const h of headerMap) {
      evalObj[h.name] = (rowValues[h.colIndex - 1] !== undefined) ? rowValues[h.colIndex - 1] : "";
    }

    if (evaluateFilterConditions(evalObj, normalizedFilters, matchAll)) {
      matchedRawValues.push(rowValues);
      matchedRowNumbers.push(currentRowNumber);
    }
  }

  const paginatedRawValues = matchedRawValues.slice(offset, offset + limit);
  const paginatedRowNumbers = matchedRowNumbers.slice(offset, offset + limit);

  const targetColumns = (Array.isArray(args.columns) && args.columns.length > 0)
    ? args.columns.map(c => String(c).trim().toLowerCase())
    : null;
  const filteredHeaders = headerMap.filter(h => !targetColumns || targetColumns.includes(h.name.toLowerCase()));
  const maxCellLength = Number(args.maxCellLength) || null;
  const omitEmpty = args.omitEmpty === true;
  const includeRowNumber = args.includeRowNumber !== false;
  const format = args.format === "compact" ? "compact" : "objects";

  let formattedRows;
  let compactHeaders = null;

  if (format === "compact") {
    compactHeaders = filteredHeaders.map(h => h.name);
    if (includeRowNumber) compactHeaders.unshift("_rowNumber");

    formattedRows = [];
    for (let r = 0; r < paginatedRawValues.length; r++) {
      const rowItem = [];
      if (includeRowNumber) rowItem.push(paginatedRowNumbers[r]);
      const rowData = paginatedRawValues[r];
      for (const h of filteredHeaders) {
        let cellVal = (rowData[h.colIndex - 1] !== undefined) ? rowData[h.colIndex - 1] : "";
        cellVal = formatCellValue(cellVal, maxCellLength);
        rowItem.push(cellVal);
      }
      formattedRows.push(rowItem);
    }
  } else {
    formattedRows = [];
    for (let r = 0; r < paginatedRawValues.length; r++) {
      const rowObj = {};
      if (includeRowNumber) rowObj["_rowNumber"] = paginatedRowNumbers[r];
      const rowData = paginatedRawValues[r];
      for (const h of filteredHeaders) {
        let cellVal = (rowData[h.colIndex - 1] !== undefined) ? rowData[h.colIndex - 1] : "";
        cellVal = formatCellValue(cellVal, maxCellLength);
        if (omitEmpty && (cellVal === "" || cellVal === null || cellVal === undefined)) continue;
        rowObj[h.name] = cellVal;
      }
      formattedRows.push(rowObj);
    }
  }

  const response = {
    sheetName: sheet.getName(),
    totalMatched: matchedRawValues.length,
    returnedRows: formattedRows.length,
    offset: offset,
    limit: limit
  };

  if (format === "compact") {
    response.format = "compact";
    response.headers = compactHeaders;
    response.rows = formattedRows;
  } else {
    response.rows = formattedRows;
  }

  return response;
}

/**
 * Tool: get_row
 * Retrieves a single full row by unique ID (UID) or row number.
 * By default returns full untruncated content.
 */
function toolGetRow(args) {
  if (!args.sheetName) throw new Error("Missing required argument: 'sheetName'");
  if (!args.rowIdentifier) throw new Error("Missing required argument: 'rowIdentifier'");

  const ss = getSpreadsheet(args.spreadsheetId);
  const sheet = getSheetOrThrow(ss, args.sheetName);
  const headerRowIndex = Number(args.headerRow) || 1;
  const renderOption = args.valueRenderOption || "FORMATTED_VALUE";
  const maxCellLength = Number(args.maxCellLength) || null; // default null = full untruncated content!

  const targetRows = resolveRowNumbers(sheet, headerRowIndex, args.rowIdentifier);
  if (targetRows.length === 0) {
    throw new Error("No matching row found for provided rowIdentifier.");
  }
  const targetRowNumber = targetRows[0];

  const lastCol = sheet.getLastColumn();
  const rawHeaders = sheet.getRange(headerRowIndex, 1, 1, lastCol).getValues()[0];
  const headerMap = mapHeaders(rawHeaders);

  const targetColumns = (Array.isArray(args.columns) && args.columns.length > 0)
    ? args.columns.map(c => String(c).trim().toLowerCase())
    : null;

  const rowRange = sheet.getRange(targetRowNumber, 1, 1, lastCol);
  const rowValues = fetchRangeData(rowRange, renderOption)[0];

  const rowObj = {
    _rowNumber: targetRowNumber
  };
  for (const h of headerMap) {
    if (targetColumns && !targetColumns.includes(h.name.toLowerCase())) {
      continue;
    }
    let cellVal = (rowValues[h.colIndex - 1] !== undefined) ? rowValues[h.colIndex - 1] : "";
    if (maxCellLength) {
      cellVal = formatCellValue(cellVal, maxCellLength);
    }
    rowObj[h.name] = cellVal;
  }

  return {
    sheetName: sheet.getName(),
    rowNumber: targetRowNumber,
    row: rowObj
  };
}

/**
 * Tool: insert_row
 * Automatically finds the end of contents and appends without requiring a row number or position.
 */
function toolInsertRow(args) {
  if (!args.sheetName) throw new Error("Missing required argument: 'sheetName'");
  if (!args.data || typeof args.data !== "object") throw new Error("Missing required argument: 'data'");

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);

    const ss = getSpreadsheet(args.spreadsheetId);
    const sheet = getSheetOrThrow(ss, args.sheetName);
    const headerRowIndex = Number(args.headerRow) || 1;
    const lastCol = sheet.getLastColumn();

    if (lastCol === 0) {
      throw new Error("Cannot insert row into an empty sheet without headers.");
    }

    const rawHeaders = sheet.getRange(headerRowIndex, 1, 1, lastCol).getValues()[0];
    const headerMap = mapHeaders(rawHeaders);

    // Identify system columns (UID, created_at, updated_at)
    let idColName = args.idColumn || null;
    let createdColName = null;
    let updatedColName = null;

    for (const h of headerMap) {
      if (!idColName && isMatchColumn(h.name, CONFIG.DEFAULT_ID_COLUMNS)) idColName = h.name;
      if (!createdColName && isMatchColumn(h.name, CONFIG.DEFAULT_CREATED_COLUMNS)) createdColName = h.name;
      if (!updatedColName && isMatchColumn(h.name, CONFIG.DEFAULT_UPDATED_COLUMNS)) updatedColName = h.name;
    }

    const rowData = Object.assign({}, args.data);
    const nowIso = new Date().toISOString();

    // Auto-generate UID if column exists and value not provided
    if (idColName && (rowData[idColName] === undefined || rowData[idColName] === "")) {
      rowData[idColName] = Utilities.getUuid();
    }

    // Auto-populate timestamps
    if (createdColName && (rowData[createdColName] === undefined || rowData[createdColName] === "")) {
      rowData[createdColName] = nowIso;
    }
    if (updatedColName && (rowData[updatedColName] === undefined || rowData[updatedColName] === "")) {
      rowData[updatedColName] = nowIso;
    }

    // Determine target row number - automatically appends to the end of contents
    let targetRow;
    const pos = args.position || "append";
    if (pos === "top") {
      targetRow = headerRowIndex + 1;
      sheet.insertRowAfter(headerRowIndex);
    } else if (typeof pos === "number" && pos > headerRowIndex) {
      targetRow = Math.min(pos, sheet.getLastRow() + 1);
      sheet.insertRowBefore(targetRow);
    } else {
      // Default: auto-detect end of contents and append
      targetRow = Math.max(headerRowIndex + 1, sheet.getLastRow() + 1);
      if (targetRow > sheet.getMaxRows()) {
        sheet.insertRowAfter(sheet.getMaxRows());
      }
    }

    // Populate cell values / formulas
    const valuesRow = [];
    const formulasRow = [];
    let hasFormulas = false;

    for (let c = 0; c < lastCol; c++) {
      const colIndex = c + 1;
      const headerItem = headerMap.find(h => h.colIndex === colIndex);
      const val = (headerItem && rowData[headerItem.name] !== undefined) ? rowData[headerItem.name] : "";

      if (typeof val === "string" && val.startsWith("=")) {
        formulasRow.push(val);
        valuesRow.push("");
        hasFormulas = true;
      } else {
        formulasRow.push("");
        valuesRow.push(val);
      }
    }

    const targetRange = sheet.getRange(targetRow, 1, 1, lastCol);
    targetRange.setValues([valuesRow]);

    if (hasFormulas) {
      for (let c = 0; c < lastCol; c++) {
        if (formulasRow[c]) {
          sheet.getRange(targetRow, c + 1).setFormula(formulasRow[c]);
        }
      }
    }

    SpreadsheetApp.flush();

    rowData["_rowNumber"] = targetRow;

    // Token efficiency: return concise confirmation by default
    const returnFull = args.returnFullRow === true;
    const response = {
      success: true,
      sheetName: sheet.getName(),
      rowNumber: targetRow,
      assignedId: idColName ? rowData[idColName] : null,
      message: "Row inserted successfully at row " + targetRow + "."
    };
    if (returnFull) {
      response.insertedData = rowData;
    }
    return response;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Tool: update_row
 * Supports updating by UID, row number, or column match (e.g. column: "name", value: "bob").
 * When matching by column, updates ALL matching rows.
 */
function toolUpdateRow(args) {
  if (!args.sheetName) throw new Error("Missing required argument: 'sheetName'");
  if (!args.rowIdentifier) throw new Error("Missing required argument: 'rowIdentifier'");
  if (!args.data || typeof args.data !== "object") throw new Error("Missing required argument: 'data'");

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);

    const ss = getSpreadsheet(args.spreadsheetId);
    const sheet = getSheetOrThrow(ss, args.sheetName);
    const headerRowIndex = Number(args.headerRow) || 1;

    const targetRows = resolveRowNumbers(sheet, headerRowIndex, args.rowIdentifier);
    if (targetRows.length === 0) {
      return {
        success: true,
        sheetName: sheet.getName(),
        rowsUpdated: 0,
        message: "No matching rows found to update."
      };
    }

    const lastCol = sheet.getLastColumn();
    const rawHeaders = sheet.getRange(headerRowIndex, 1, 1, lastCol).getValues()[0];
    const headerMap = mapHeaders(rawHeaders);

    // Auto-detect updated_at column
    let updatedColName = null;
    for (const h of headerMap) {
      if (isMatchColumn(h.name, CONFIG.DEFAULT_UPDATED_COLUMNS)) {
        updatedColName = h.name;
        break;
      }
    }

    const updateData = Object.assign({}, args.data);
    if (updatedColName && updateData[updatedColName] === undefined) {
      updateData[updatedColName] = new Date().toISOString();
    }

    const updatedFields = [];

    // Apply updates across all matching rows
    for (const targetRow of targetRows) {
      for (const [key, val] of Object.entries(updateData)) {
        if (key === "_rowNumber") continue;
        const headerItem = headerMap.find(h => h.name.toLowerCase() === key.toLowerCase());
        if (headerItem) {
          const cell = sheet.getRange(targetRow, headerItem.colIndex);
          if (typeof val === "string" && val.startsWith("=")) {
            cell.setFormula(val);
          } else {
            cell.setValue(val);
          }
          if (!updatedFields.includes(headerItem.name)) {
            updatedFields.push(headerItem.name);
          }
        }
      }
    }

    SpreadsheetApp.flush();

    // Token efficiency: return concise confirmation by default
    const returnFull = args.returnFullRow === true;
    const response = {
      success: true,
      sheetName: sheet.getName(),
      rowsUpdated: targetRows.length,
      updatedRowNumbers: targetRows,
      updatedFields: updatedFields,
      message: "Updated " + targetRows.length + " row(s) successfully."
    };

    if (returnFull) {
      const refreshedList = [];
      for (const targetRow of targetRows) {
        const refreshedValues = sheet.getRange(targetRow, 1, 1, lastCol).getDisplayValues()[0];
        const resultObj = { _rowNumber: targetRow };
        for (const h of headerMap) {
          resultObj[h.name] = refreshedValues[h.colIndex - 1] !== undefined ? refreshedValues[h.colIndex - 1] : "";
        }
        refreshedList.push(resultObj);
      }
      response.updatedRows = refreshedList;
    }

    return response;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Tool: delete_row
 * Supports deleting by UID, row number, or column match (e.g. column: "name", value: "bob").
 * When matching by column, deletes ALL matching rows from bottom-to-top.
 */
function toolDeleteRow(args) {
  if (!args.sheetName) throw new Error("Missing required argument: 'sheetName'");
  if (!args.rowIdentifier) throw new Error("Missing required argument: 'rowIdentifier'");

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);

    const ss = getSpreadsheet(args.spreadsheetId);
    const sheet = getSheetOrThrow(ss, args.sheetName);
    const headerRowIndex = Number(args.headerRow) || 1;

    const targetRows = resolveRowNumbers(sheet, headerRowIndex, args.rowIdentifier);
    if (targetRows.length === 0) {
      return {
        success: true,
        sheetName: sheet.getName(),
        rowsDeleted: 0,
        message: "No matching rows found to delete."
      };
    }

    const lastCol = sheet.getLastColumn();
    const rawHeaders = sheet.getRange(headerRowIndex, 1, 1, lastCol).getValues()[0];
    const headerMap = mapHeaders(rawHeaders);

    // Read row contents before deletion
    const deletedRecords = [];
    for (const targetRow of targetRows) {
      const oldValues = sheet.getRange(targetRow, 1, 1, lastCol).getDisplayValues()[0];
      const record = { _rowNumber: targetRow };
      for (const h of headerMap) {
        record[h.name] = oldValues[h.colIndex - 1] !== undefined ? oldValues[h.colIndex - 1] : "";
      }
      deletedRecords.push(record);
    }

    // Sort descending so deletion doesn't shift remaining target row indices
    const rowsToDeleteDescending = targetRows.slice().sort((a, b) => b - a);
    for (const r of rowsToDeleteDescending) {
      sheet.deleteRow(r);
    }

    SpreadsheetApp.flush();

    return {
      success: true,
      sheetName: sheet.getName(),
      rowsDeleted: targetRows.length,
      deletedRowNumbers: targetRows,
      deletedData: deletedRecords,
      message: "Deleted " + targetRows.length + " row(s) successfully."
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Tool: setup_sheet_system_columns
 * Automatically adds UID, created_at, and updated_at columns if missing and backfills existing rows.
 */
function toolSetupSheetSystemColumns(args) {
  if (!args.sheetName) throw new Error("Missing required argument: 'sheetName'");

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);

    const ss = getSpreadsheet(args.spreadsheetId);
    const sheet = getSheetOrThrow(ss, args.sheetName);
    const headerRowIndex = Number(args.headerRow) || 1;

    const includeUid = args.includeUid !== false;
    const includeCreatedAt = args.includeCreatedAt !== false;
    const includeUpdatedAt = args.includeUpdatedAt !== false;
    const backfillExisting = args.backfillExisting !== false;
    const freezeHeader = args.freezeHeader === true;

    const idColName = args.idColumnName || "_uid";
    const createdColName = args.createdAtColumnName || "_created_at";
    const updatedColName = args.updatedAtColumnName || "_updated_at";
    const idPrefix = args.idPrefix !== undefined ? args.idPrefix : "rec_";

    let lastCol = sheet.getLastColumn();
    const lastRow = sheet.getLastRow();

    const targetCols = [];
    if (includeUid) targetCols.push(idColName);
    if (includeCreatedAt) targetCols.push(createdColName);
    if (includeUpdatedAt) targetCols.push(updatedColName);

    if (lastCol === 0) {
      if (targetCols.length === 0) {
        throw new Error("No columns specified to add on empty sheet.");
      }
      sheet.getRange(headerRowIndex, 1, 1, targetCols.length).setValues([targetCols]);
      sheet.getRange(headerRowIndex, 1, 1, targetCols.length).setFontWeight("bold");
      if (freezeHeader || sheet.getFrozenRows() === 0) sheet.setFrozenRows(headerRowIndex);
      SpreadsheetApp.flush();
      return {
        success: true,
        sheetName: sheet.getName(),
        columnsAdded: targetCols,
        systemColumns: {
          idColumn: includeUid ? idColName : null,
          createdAtColumn: includeCreatedAt ? createdColName : null,
          updatedAtColumn: includeUpdatedAt ? updatedColName : null
        },
        totalRows: 0,
        rowsBackfilled: 0,
        message: "Created initial system column headers on empty sheet."
      };
    }

    const rawHeaders = sheet.getRange(headerRowIndex, 1, 1, lastCol).getValues()[0];
    const existingHeadersLower = rawHeaders.map(h => String(h).trim().toLowerCase());

    const columnsToAdd = [];
    if (includeUid && !existingHeadersLower.includes(idColName.toLowerCase())) columnsToAdd.push(idColName);
    if (includeCreatedAt && !existingHeadersLower.includes(createdColName.toLowerCase())) columnsToAdd.push(createdColName);
    if (includeUpdatedAt && !existingHeadersLower.includes(updatedColName.toLowerCase())) columnsToAdd.push(updatedColName);

    // Add missing column headers to the right
    if (columnsToAdd.length > 0) {
      const startNewCol = lastCol + 1;
      const headerRange = sheet.getRange(headerRowIndex, startNewCol, 1, columnsToAdd.length);
      headerRange.setValues([columnsToAdd]);
      headerRange.setFontWeight("bold");
      lastCol += columnsToAdd.length;
    }

    if (freezeHeader && sheet.getFrozenRows() === 0) {
      sheet.setFrozenRows(headerRowIndex);
    }

    // Refresh headers mapping
    const updatedRawHeaders = sheet.getRange(headerRowIndex, 1, 1, lastCol).getValues()[0];
    const idColIdx = includeUid ? (updatedRawHeaders.findIndex(h => String(h).trim().toLowerCase() === idColName.toLowerCase()) + 1) : 0;
    const createdColIdx = includeCreatedAt ? (updatedRawHeaders.findIndex(h => String(h).trim().toLowerCase() === createdColName.toLowerCase()) + 1) : 0;
    const updatedColIdx = includeUpdatedAt ? (updatedRawHeaders.findIndex(h => String(h).trim().toLowerCase() === updatedColName.toLowerCase()) + 1) : 0;

    const dataRowCount = Math.max(0, lastRow - headerRowIndex);
    let backfilledCount = 0;

    if (dataRowCount > 0 && backfillExisting) {
      const nowIso = new Date().toISOString();
      const entireDataRange = sheet.getRange(headerRowIndex + 1, 1, dataRowCount, lastCol);
      const dataValues = entireDataRange.getValues();

      for (let r = 0; r < dataRowCount; r++) {
        // Verify row has at least some content
        const hasContent = dataValues[r].some((val, idx) => {
          const colNum = idx + 1;
          if (colNum === idColIdx || colNum === createdColIdx || colNum === updatedColIdx) return false;
          return val !== "" && val !== null && val !== undefined;
        });

        if (!hasContent) continue;

        let modified = false;

        // Check UID
        if (idColIdx > 0) {
          const currentId = dataValues[r][idColIdx - 1];
          if (!currentId || String(currentId).trim() === "") {
            dataValues[r][idColIdx - 1] = idPrefix + Utilities.getUuid().substring(0, 8);
            modified = true;
          }
        }

        // Check created_at
        if (createdColIdx > 0) {
          const currentCreated = dataValues[r][createdColIdx - 1];
          if (!currentCreated || String(currentCreated).trim() === "") {
            dataValues[r][createdColIdx - 1] = nowIso;
            modified = true;
          }
        }

        // Check updated_at
        if (updatedColIdx > 0) {
          const currentUpdated = dataValues[r][updatedColIdx - 1];
          if (!currentUpdated || String(currentUpdated).trim() === "") {
            dataValues[r][updatedColIdx - 1] = nowIso;
            modified = true;
          }
        }

        if (modified) backfilledCount++;
      }

      if (backfilledCount > 0) {
        entireDataRange.setValues(dataValues);
      }
    }

    SpreadsheetApp.flush();

    return {
      success: true,
      sheetName: sheet.getName(),
      columnsAdded: columnsToAdd,
      systemColumns: {
        idColumn: idColIdx > 0 ? idColName : null,
        createdAtColumn: createdColIdx > 0 ? createdColName : null,
        updatedAtColumn: updatedColIdx > 0 ? updatedColName : null
      },
      totalRows: dataRowCount,
      rowsBackfilled: backfilledCount
    };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================================
// HELPER UTILITIES
// ============================================================================

/**
 * Open spreadsheet by ID or fallback to configured default / active sheet
 */
function getSpreadsheet(spreadsheetId) {
  if (spreadsheetId && String(spreadsheetId).trim()) {
    return SpreadsheetApp.openById(spreadsheetId.trim());
  }

  const propId = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  if (propId) {
    return SpreadsheetApp.openById(propId);
  }

  try {
    const active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) return active;
  } catch (err) {
    // Standalone script, not container-bound
  }

  return SpreadsheetApp.openById(CONFIG.DEFAULT_SPREADSHEET_ID);
}

/**
 * Get sheet tab by name or throw descriptive error listing available sheets
 */
function getSheetOrThrow(spreadsheet, sheetName) {
  const sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    const available = spreadsheet.getSheets().map(s => s.getName());
    throw new Error("Sheet '" + sheetName + "' not found. Available sheets: " + available.join(", "));
  }
  return sheet;
}

/**
 * Map raw headers to indexed metadata objects
 */
function mapHeaders(rawHeaders) {
  const list = [];
  for (let i = 0; i < rawHeaders.length; i++) {
    const name = String(rawHeaders[i]).trim();
    if (name) {
      list.push({
        name: name,
        colIndex: i + 1,
        colLetter: indexToColumnLetter(i + 1)
      });
    }
  }
  return list;
}

/**
 * Convert 1-based column index to letter (1 -> A, 27 -> AA)
 */
function indexToColumnLetter(colIndex) {
  let letter = "";
  let temp = colIndex;
  while (temp > 0) {
    const rem = (temp - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    temp = Math.floor((temp - rem) / 26);
  }
  return letter;
}

/**
 * Check if header name matches list of candidates (case-insensitive)
 */
function isMatchColumn(headerName, candidates) {
  if (!headerName || !candidates) return false;
  const clean = headerName.trim().toLowerCase();
  for (const cand of candidates) {
    if (clean === cand.toLowerCase()) return true;
  }
  return false;
}

/**
 * Fetch 2D array data based on valueRenderOption
 */
function fetchRangeData(range, renderOption) {
  if (renderOption === "UNFORMATTED_VALUE") {
    return range.getValues();
  } else if (renderOption === "FORMULA") {
    const formulas = range.getFormulas();
    const displayValues = range.getDisplayValues();
    // Return formula if present, else fallback to formatted value
    return formulas.map((row, r) =>
      row.map((cell, c) => (cell !== "" ? cell : displayValues[r][c]))
    );
  } else {
    // Default: FORMATTED_VALUE
    return range.getDisplayValues();
  }
}

/**
 * Resolve 1-based sheet row numbers from rowIdentifier.
 * Supports:
 * - { column: "name", value: "bob", operator?: "eq" } (matches ALL matching rows)
 * - { rowNumber: 2 } or { rowNumbers: [2, 3] }
 * - { uid: "CMP-1001", idColumn?: "Company ID" }
 * - { where: { column: "name", value: "bob" } }
 * Returns array of 1-based row numbers.
 */
function resolveRowNumbers(sheet, headerRowIndex, rowIdentifier) {
  if (!rowIdentifier || typeof rowIdentifier !== "object") {
    throw new Error("Invalid rowIdentifier: must be an object with 'column' & 'value', 'rowNumber', or 'uid'.");
  }

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();

  if (lastRow <= headerRowIndex) {
    return [];
  }

  // 1. Direct row number(s)
  if (rowIdentifier.rowNumber !== undefined && rowIdentifier.rowNumber !== null) {
    const rowNum = Number(rowIdentifier.rowNumber);
    if (isNaN(rowNum) || rowNum <= headerRowIndex || rowNum > lastRow) {
      throw new Error("Row number " + rowNum + " is out of bounds (valid range: " + (headerRowIndex + 1) + " to " + lastRow + ").");
    }
    return [rowNum];
  }

  if (Array.isArray(rowIdentifier.rowNumbers)) {
    return rowIdentifier.rowNumbers.map(n => Number(n)).filter(n => n > headerRowIndex && n <= lastRow);
  }

  // 2. Identify by column & value (e.g. column: "name", value: "bob")
  const colName = rowIdentifier.column || (rowIdentifier.where && rowIdentifier.where.column);
  if (colName !== undefined && colName !== null) {
    const targetVal = rowIdentifier.value !== undefined ? rowIdentifier.value : (rowIdentifier.where && rowIdentifier.where.value);
    const op = (rowIdentifier.operator || (rowIdentifier.where && rowIdentifier.where.operator) || "eq").toLowerCase();

    const rawHeaders = sheet.getRange(headerRowIndex, 1, 1, lastCol).getValues()[0];
    const targetColIdx = rawHeaders.findIndex(h => String(h).trim().toLowerCase() === String(colName).trim().toLowerCase()) + 1;

    if (targetColIdx === 0) {
      throw new Error("Column '" + colName + "' not found in sheet headers.");
    }

    const dataRowCount = lastRow - headerRowIndex;
    const colValues = sheet.getRange(headerRowIndex + 1, targetColIdx, dataRowCount, 1).getValues();
    const matchingRows = [];

    for (let r = 0; r < dataRowCount; r++) {
      const cellVal = colValues[r][0];
      if (checkCondition(cellVal, op, targetVal)) {
        matchingRows.push(headerRowIndex + 1 + r);
      }
    }

    return matchingRows;
  }

  // 3. Identify by UID
  if (rowIdentifier.uid !== undefined && rowIdentifier.uid !== null) {
    const targetUid = String(rowIdentifier.uid).trim();
    if (!targetUid) throw new Error("rowIdentifier 'uid' cannot be empty.");

    const rawHeaders = sheet.getRange(headerRowIndex, 1, 1, lastCol).getValues()[0];
    let idColIndex = -1;

    // Custom idColumn specified
    if (rowIdentifier.idColumn) {
      idColIndex = rawHeaders.findIndex(h => String(h).trim().toLowerCase() === rowIdentifier.idColumn.toLowerCase()) + 1;
      if (idColIndex === 0) {
        throw new Error("Specified idColumn '" + rowIdentifier.idColumn + "' not found in sheet headers.");
      }
    } else {
      // Find candidate UID column
      for (let i = 0; i < rawHeaders.length; i++) {
        if (isMatchColumn(String(rawHeaders[i]), CONFIG.DEFAULT_ID_COLUMNS)) {
          idColIndex = i + 1;
          break;
        }
      }
    }

    if (idColIndex <= 0) {
      throw new Error("No unique ID column found to search for UID '" + targetUid + "'. Specify 'idColumn', 'column', or 'rowNumber'.");
    }

    const dataRowCount = lastRow - headerRowIndex;
    if (dataRowCount <= 0) {
      return [];
    }

    const colValues = sheet.getRange(headerRowIndex + 1, idColIndex, dataRowCount, 1).getDisplayValues();
    for (let r = 0; r < colValues.length; r++) {
      if (String(colValues[r][0]).trim() === targetUid) {
        return [headerRowIndex + 1 + r];
      }
    }

    return [];
  }

  throw new Error("rowIdentifier must contain 'column' & 'value', 'uid', or 'rowNumber'.");
}

/**
 * Backward-compatibility wrapper returning first matched row number
 */
function resolveRowNumber(sheet, headerRowIndex, rowIdentifier) {
  const rows = resolveRowNumbers(sheet, headerRowIndex, rowIdentifier);
  if (rows.length === 0) {
    throw new Error("No matching row found for provided rowIdentifier.");
  }
  return rows[0];
}

/**
 * Normalize filters into an array of { column, operator, value }
 */
function normalizeFilters(filters) {
  if (Array.isArray(filters)) {
    return filters.map(f => ({
      column: f.column || f.field || f.header,
      operator: (f.operator || f.op || "eq").toLowerCase(),
      value: f.value
    }));
  }

  if (typeof filters === "object" && filters !== null) {
    const arr = [];
    for (const [col, val] of Object.entries(filters)) {
      if (typeof val === "object" && val !== null && !Array.isArray(val)) {
        arr.push({
          column: col,
          operator: (val.operator || val.op || "eq").toLowerCase(),
          value: val.value
        });
      } else {
        arr.push({
          column: col,
          operator: "eq",
          value: val
        });
      }
    }
    return arr;
  }

  return [];
}

/**
 * Evaluate filter conditions against a row object
 */
function evaluateFilterConditions(rowObj, filterConditions, matchAll) {
  if (filterConditions.length === 0) return true;

  // Case-insensitive lookup map for row keys
  const rowLookup = {};
  for (const [k, v] of Object.entries(rowObj)) {
    rowLookup[k.toLowerCase()] = v;
  }

  for (const filter of filterConditions) {
    const colNameLower = String(filter.column).toLowerCase();
    const cellValue = rowLookup[colNameLower];
    const targetValue = filter.value;
    const op = filter.operator;

    const matched = checkCondition(cellValue, op, targetValue);

    if (matchAll && !matched) return false;
    if (!matchAll && matched) return true;
  }

  return matchAll;
}

/**
 * Compare cellValue with targetValue according to operator
 */
function checkCondition(cellValue, operator, targetValue) {
  const cellStr = (cellValue !== null && cellValue !== undefined) ? String(cellValue) : "";
  const targetStr = (targetValue !== null && targetValue !== undefined) ? String(targetValue) : "";

  switch (operator) {
    case "eq":
    case "==":
    case "===":
      return cellStr.toLowerCase() === targetStr.toLowerCase();

    case "ne":
    case "!=":
    case "!==":
      return cellStr.toLowerCase() !== targetStr.toLowerCase();

    case "contains":
      return cellStr.toLowerCase().includes(targetStr.toLowerCase());

    case "not_contains":
      return !cellStr.toLowerCase().includes(targetStr.toLowerCase());

    case "starts_with":
      return cellStr.toLowerCase().startsWith(targetStr.toLowerCase());

    case "ends_with":
      return cellStr.toLowerCase().endsWith(targetStr.toLowerCase());

    case "is_empty":
      return cellStr.trim() === "";

    case "is_not_empty":
      return cellStr.trim() !== "";

    case "gt":
    case ">":
      return Number(cellValue) > Number(targetValue);

    case "gte":
    case ">=":
      return Number(cellValue) >= Number(targetValue);

    case "lt":
    case "<":
      return Number(cellValue) < Number(targetValue);

    case "lte":
    case "<=":
      return Number(cellValue) <= Number(targetValue);

    case "in":
      if (Array.isArray(targetValue)) {
        return targetValue.map(v => String(v).toLowerCase()).includes(cellStr.toLowerCase());
      }
      return false;

    default:
      // Default to case-insensitive equality
      return cellStr.toLowerCase() === targetStr.toLowerCase();
  }
}

/**
 * Return JSON HTTP output
 */
function jsonResponse(data, statusCode) {
  const textOutput = ContentService.createTextOutput(JSON.stringify(data, null, 2));
  textOutput.setMimeType(ContentService.MimeType.JSON);
  return textOutput;
}

/**
 * Render interactive HTML Dashboard for browser visits
 */
function renderDashboardHtml(params) {
  let spreadsheetName = "Unknown";
  let spreadsheetId = CONFIG.DEFAULT_SPREADSHEET_ID;
  let sheetCount = 0;

  try {
    const ss = getSpreadsheet(params.spreadsheetId);
    spreadsheetId = ss.getId();
    spreadsheetName = ss.getName();
    sheetCount = ss.getSheets().length;
  } catch (err) {
    spreadsheetName = "Error connecting: " + err.message;
  }

  const hasApiKey = !!PropertiesService.getScriptProperties().getProperty("API_KEY");
  const tools = getToolDefinitions();

  const toolCards = tools.map(t => `
    <div style="background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 16px; margin-bottom: 16px;">
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <code style="color: #64b5f6; font-size: 15px; font-weight: 600;">${t.name}</code>
        <span style="font-size: 12px; background: rgba(100,181,246,0.15); color: #90caf9; padding: 2px 8px; border-radius: 12px;">Tool</span>
      </div>
      <p style="color: #ccc; margin: 8px 0 12px 0; font-size: 13px;">${t.description}</p>
      <details style="font-size: 12px; color: #aaa;">
        <summary style="cursor: pointer; color: #81c784;">View Input Schema</summary>
        <pre style="background: rgba(0,0,0,0.3); padding: 10px; border-radius: 6px; overflow-x: auto; color: #a5d6a7; margin-top: 8px;">${JSON.stringify(t.inputSchema, null, 2)}</pre>
      </details>
    </div>
  `).join("");

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Google Sheets MCP Server</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #0f172a;
      color: #f1f5f9;
      margin: 0;
      padding: 32px 16px;
      line-height: 1.5;
    }
    .container {
      max-width: 860px;
      margin: 0 auto;
    }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
    }
    .badge-green { background: #166534; color: #86efac; }
    .badge-yellow { background: #854d0e; color: #fde047; }
    .card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 24px;
      box-shadow: 0 4px 6px -1px rgba(0,0,0,0.2);
    }
    pre {
      background: #090d16;
      border: 1px solid #1e293b;
      border-radius: 8px;
      padding: 12px;
      color: #38bdf8;
      overflow-x: auto;
      font-size: 13px;
    }
    a { color: #38bdf8; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
      <div>
        <h1 style="margin: 0; font-size: 24px;">Google Sheets MCP Server</h1>
        <p style="margin: 4px 0 0 0; color: #94a3b8; font-size: 14px;">Model Context Protocol (JSON-RPC 2.0) Endpoint</p>
      </div>
      <div>
        <span class="badge badge-green">Server Active</span>
      </div>
    </div>

    <div class="card">
      <h3 style="margin-top: 0; font-size: 16px;">Target Spreadsheet Status</h3>
      <p style="margin: 4px 0;"><strong>Name:</strong> ${spreadsheetName}</p>
      <p style="margin: 4px 0;"><strong>Spreadsheet ID:</strong> <code>${spreadsheetId}</code></p>
      <p style="margin: 4px 0;"><strong>Sheets:</strong> ${sheetCount} tabs available</p>
      <p style="margin: 4px 0;"><strong>Auth Requirement:</strong> ${hasApiKey ? '<span class="badge badge-yellow">API Key Required</span>' : '<span class="badge badge-green">Open / Google Auth</span>'}</p>
      <p style="margin: 8px 0 0 0;"><a href="https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit" target="_blank">Open Spreadsheet in Google Sheets &rarr;</a></p>
    </div>

    <div class="card">
      <h3 style="margin-top: 0; font-size: 16px;">Connecting MCP Clients</h3>
      <p style="font-size: 14px; color: #cbd5e1;">Configure your MCP client (Claude Desktop, Cursor, Gemini Spark, etc.) with HTTP transport:</p>
      <pre>POST /exec
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "get_sheet_contents",
    "arguments": {
      "sheetName": "Companies",
      "limit": 5
    }
  }
}</pre>
    </div>

    <div class="card">
      <h3 style="margin-top: 0; font-size: 16px;">Available MCP Tools (${tools.length})</h3>
      ${toolCards}
    </div>
  </div>
</body>
</html>
  `;

  return HtmlService.createHtmlOutput(html)
    .setTitle("Google Sheets MCP Server")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ============================================================================
// SELF-TEST DIAGNOSTIC SUITE
// ============================================================================

/**
 * Diagnostic test runner to verify all functions locally in Apps Script
 */
function testMCP() {
  Logger.log("=== STARTING MCP SELF-TEST DIAGNOSTICS ===");

  // 1. List Sheets
  const sheetsRes = toolListSheets({});
  Logger.log("[PASS] list_sheets: found " + sheetsRes.totalSheets + " sheets: " + sheetsRes.sheets.map(s => s.name).join(", "));

  // 2. Get Schema
  const schemaRes = toolGetSheetSchema({ sheetName: "Companies" });
  Logger.log("[PASS] get_sheet_schema (Companies): " + schemaRes.headers.length + " columns. ID column: " + schemaRes.detectedIdColumn);

  // 3. Get Contents
  const contentsRes = toolGetSheetContents({ sheetName: "Companies", limit: 3 });
  Logger.log("[PASS] get_sheet_contents (Companies): returned " + contentsRes.returnedRows + " rows.");

  // 4. Filtered Contents
  const filterRes = toolGetFilteredSheetContents({
    sheetName: "Companies",
    filters: { Industry: "Technology" }
  });
  Logger.log("[PASS] get_filtered_sheet_contents (Industry=Technology): matched " + filterRes.totalMatched + " rows.");

  // 5. Test JSON-RPC initialize
  const initRes = handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {}
  });
  Logger.log("[PASS] JSON-RPC initialize: protocolVersion=" + initRes.result.protocolVersion);

  // 6. Test JSON-RPC tools/list
  const toolsRes = handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  });
  Logger.log("[PASS] JSON-RPC tools/list: " + toolsRes.result.tools.length + " tools registered.");

  Logger.log("=== ALL MCP SELF-TEST DIAGNOSTICS PASSED ===");
  return { success: true };
}

// ============================================================================
// GOOGLE SHEETS UI INTEGRATION (MENUS & MODAL DIALOGS)
// ============================================================================

/**
 * Triggered when spreadsheet is opened. Adds custom MCP Server menu.
 */
function onOpen(e) {
  try {
    const ui = SpreadsheetApp.getUi();
    ui.createMenu("🤖 MCP Server")
      .addItem("🚀 Run Diagnostics & Test Auth", "menuRunDiagnostics")
      .addSeparator()
      .addItem("✨ Setup Sheet Tracking Wizard...", "menuSheetSetupWizard")
      .addItem("➕ Add All Tracking Columns (_uid, _updated_at, _created_at)", "menuAddAllTrackingColumns")
      .addSubMenu(ui.createMenu("⚙️ Individual Column Tools")
        .addItem("🆔 Add UID Column (_uid)", "menuAddUidColumn")
        .addItem("🕒 Add Updated At Column (_updated_at)", "menuAddUpdatedAtColumn")
        .addItem("📅 Add Created At Column (_created_at)", "menuAddCreatedAtColumn")
        .addSeparator()
        .addItem("🔄 Backfill Missing UIDs Only", "menuBackfillUids")
        .addItem("⏱️ Backfill Missing Timestamps Only", "menuBackfillTimestamps")
        .addSeparator()
        .addItem("🌐 Setup System Columns on ALL Sheets", "menuSetupSystemColumnsAllSheets")
      )
      .addSeparator()
      .addItem("🔓 Switch to Open Mode (No Sign-in Required)", "menuDisableApiKey")
      .addItem("🔑 View / Manage Auth & API Key", "menuShowApiKey")
      .addItem("🔄 Re-generate API Key", "menuRegenerateApiKey")
      .addSeparator()
      .addItem("📖 Documentation & Connection Guide", "menuShowDocumentation")
      .addToUi();
  } catch (err) {
    Logger.log("onOpen error: " + err.message);
  }
}

/**
 * Automatically maintain system columns (_uid, _created_at, _updated_at) upon manual edits in Google Sheets.
 * ONLY triggers if the system columns already exist on the sheet.
 */
function onEdit(e) {
  try {
    if (!e || !e.range) return;

    const sheet = e.range.getSheet();
    const startRow = e.range.getRow();
    const numRows = e.range.getNumRows();
    const startCol = e.range.getColumn();
    const numCols = e.range.getNumColumns();
    const headerRowIndex = 1;

    // Do nothing if editing the header row itself
    if (startRow <= headerRowIndex) return;

    const lastCol = sheet.getLastColumn();
    if (lastCol === 0) return;

    const rawHeaders = sheet.getRange(headerRowIndex, 1, 1, lastCol).getValues()[0];

    // Detect existing system columns on this sheet
    let idColIdx = -1;
    let createdColIdx = -1;
    let updatedColIdx = -1;

    for (let c = 0; c < rawHeaders.length; c++) {
      const hName = String(rawHeaders[c]).trim().toLowerCase();
      if (idColIdx === -1 && (hName === "_uid" || hName === "uid" || hName === "id")) {
        idColIdx = c + 1;
      }
      if (createdColIdx === -1 && (hName === "_created_at" || hName === "created_at" || hName === "created at" || hName === "created date")) {
        createdColIdx = c + 1;
      }
      if (updatedColIdx === -1 && (hName === "_updated_at" || hName === "updated_at" || hName === "updated at" || hName === "edited date" || hName === "last modified")) {
        updatedColIdx = c + 1;
      }
    }

    // ONLY proceed if at least one of these columns exists on the sheet
    if (idColIdx === -1 && createdColIdx === -1 && updatedColIdx === -1) {
      return;
    }

    // Avoid updating if the edit was solely on the _updated_at or _uid column itself
    const isOnlySystemColEdit = (numCols === 1 && (startCol === idColIdx || startCol === createdColIdx || startCol === updatedColIdx));
    if (isOnlySystemColEdit && startCol === updatedColIdx) {
      return;
    }

    const nowIso = new Date().toISOString();

    for (let r = 0; r < numRows; r++) {
      const currentRow = startRow + r;
      const rowValues = sheet.getRange(currentRow, 1, 1, lastCol).getValues()[0];

      // Verify row is not completely empty
      const hasContent = rowValues.some(val => val !== "" && val !== null && val !== undefined);
      if (!hasContent) continue;

      // 1. Set UID if column exists and row lacks a UID
      if (idColIdx !== -1) {
        const currentUid = rowValues[idColIdx - 1];
        if (!currentUid || String(currentUid).trim() === "") {
          const generatedUid = "rec_" + Utilities.getUuid().substring(0, 8);
          sheet.getRange(currentRow, idColIdx).setValue(generatedUid);
        }
      }

      // 2. Set _created_at if column exists and row lacks a creation timestamp
      if (createdColIdx !== -1) {
        const currentCreated = rowValues[createdColIdx - 1];
        if (!currentCreated || String(currentCreated).trim() === "") {
          sheet.getRange(currentRow, createdColIdx).setValue(nowIso);
        }
      }

      // 3. Update _updated_at if column exists
      if (updatedColIdx !== -1) {
        sheet.getRange(currentRow, updatedColIdx).setValue(nowIso);
      }
    }
  } catch (err) {
    Logger.log("onEdit error: " + err.message);
  }
}

/**
 * Returns deployed web app URL or fallback
 */
function getWebappUrl() {
  try {
    const url = ScriptApp.getService().getUrl();
    if (url && url.indexOf("AKfy") !== -1) return url;
  } catch (err) {}
  return "https://script.google.com/macros/s/AKfycbzY8JgYGAZh4bxDomemDZHde5x_TuUdZRH7f1DA43u0tcCoa-jjy0Rt5Tc1SjknvaU6/exec";
}

/**
 * Generates secure random API key: mcp_<uuid_alphanumeric>
 */
function generateSecureApiKey() {
  const uuid = Utilities.getUuid().replace(/-/g, "");
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  return "mcp_" + uuid.substring(0, 16) + randomSuffix;
}

/**
 * Menu Action: Run Diagnostics & Test Auth
 */
function menuRunDiagnostics() {
  const ui = SpreadsheetApp.getUi();
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheets = ss.getSheets();
    const sheetSummaries = sheets.map(s => {
      const name = s.getName();
      const lastRow = s.getLastRow();
      const lastCol = s.getLastColumn();
      return `<li><strong>${name}</strong>: ${lastRow} rows, ${lastCol} columns</li>`;
    }).join("");

    const tools = getToolDefinitions();
    const webappUrl = getWebappUrl();
    const currentApiKey = PropertiesService.getScriptProperties().getProperty("API_KEY") || "(None configured - Open mode)";

    const html = `
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f1f5f9; padding: 16px; margin: 0; }
        .card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 14px; margin-bottom: 12px; }
        .status { color: #86efac; font-weight: bold; }
        h3 { margin: 0 0 8px 0; font-size: 15px; color: #60a5fa; }
        ul { margin: 4px 0; padding-left: 20px; font-size: 13px; color: #cbd5e1; }
        code { background: #020617; padding: 2px 6px; border-radius: 4px; color: #38bdf8; font-size: 12px; word-break: break-all; }
        button { background: #3b82f6; color: white; border: none; padding: 8px 16px; border-radius: 6px; font-weight: 500; cursor: pointer; float: right; margin-top: 8px; }
        button:hover { background: #2563eb; }
      </style>
      <div class="card">
        <h3><span class="status">✓</span> Authentication & Permissions Active</h3>
        <p style="font-size: 13px; margin: 4px 0; color: #cbd5e1;">Your Google account authorization is active. The MCP server can read and write to this spreadsheet.</p>
      </div>
      <div class="card">
        <h3>Spreadsheet Sheets (${sheets.length})</h3>
        <ul>${sheetSummaries}</ul>
      </div>
      <div class="card">
        <h3>MCP Protocol Engine</h3>
        <p style="font-size: 13px; margin: 4px 0; color: #cbd5e1;">Registered Tools: <strong>${tools.length} tools</strong> active.</p>
        <p style="font-size: 13px; margin: 4px 0; color: #cbd5e1;">API Key Status: <code>${currentApiKey.startsWith("mcp_") ? currentApiKey.substring(0, 10) + "..." : currentApiKey}</code></p>
      </div>
      <div class="card">
        <h3>Web App Endpoint</h3>
        <code>${webappUrl}</code>
      </div>
      <button onclick="google.script.host.close()">Close</button>
    `;

    const htmlOutput = HtmlService.createHtmlOutput(html).setWidth(520).setHeight(460);
    ui.showModalDialog(htmlOutput, "🚀 MCP Diagnostics & Auth Status");
  } catch (err) {
    ui.alert("Diagnostics Error", "Error running diagnostics: " + err.message, ui.ButtonSet.OK);
  }
}

/**
 * Menu Action: View or Manage API Key / Auth Mode
 */
function menuShowApiKey() {
  const ui = SpreadsheetApp.getUi();
  const apiKey = PropertiesService.getScriptProperties().getProperty("API_KEY");
  const webappUrl = getWebappUrl();
  const hasKey = !!apiKey;
  const authenticatedUrl = hasKey ? (webappUrl + "?apiKey=" + apiKey) : webappUrl;

  const html = `
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f1f5f9; padding: 16px; margin: 0; }
      .field { margin-bottom: 12px; }
      label { display: block; font-size: 11px; font-weight: 600; text-transform: uppercase; color: #94a3b8; margin-bottom: 6px; }
      .input-group { display: flex; gap: 8px; }
      input { flex: 1; background: #020617; border: 1px solid #334155; border-radius: 6px; padding: 8px 10px; color: #38bdf8; font-family: monospace; font-size: 13px; outline: none; }
      input:focus { border-color: #3b82f6; }
      button.btn { background: #334155; color: #e2e8f0; border: 1px solid #475569; padding: 8px 14px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500; white-space: nowrap; }
      button.btn:hover { background: #475569; }
      button.btn-primary { background: #2563eb; color: #ffffff; border-color: #3b82f6; font-weight: 600; }
      button.btn-primary:hover { background: #1d4ed8; }
      button.btn-danger { background: #7f1d1d; color: #fca5a5; border-color: #991b1b; }
      button.btn-danger:hover { background: #991b1b; }
      button.btn-success { background: #166534; color: #86efac; border-color: #15803d; }
      button.btn-success:hover { background: #15803d; }
      .banner-open { background: rgba(34, 197, 94, 0.15); border: 1px solid #16a34a; color: #86efac; padding: 10px; border-radius: 6px; font-size: 12px; margin-bottom: 12px; }
      .banner-key { background: rgba(59, 130, 246, 0.15); border: 1px solid #2563eb; color: #93c5fd; padding: 10px; border-radius: 6px; font-size: 12px; margin-bottom: 12px; }
      .subtext { display: block; font-size: 11px; color: #94a3b8; margin-top: 4px; }
      pre { background: #020617; border: 1px solid #334155; border-radius: 6px; padding: 8px 10px; font-size: 11px; color: #a5d6a7; overflow-x: auto; margin: 4px 0 0 0; }
      .btn-bar { display: flex; justify-content: space-between; align-items: center; margin-top: 16px; }
      button.close-btn { background: #3b82f6; color: white; border: none; padding: 8px 18px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; }
      button.close-btn:hover { background: #2563eb; }
    </style>

    ${hasKey ? `
      <div class="banner-key">
        🔒 <strong>API Key Enforcement Active</strong>: Incoming requests must provide this key.
      </div>

      <div class="field">
        <label>🔗 Authenticated MCP URL (Ready to Paste into Claude / Clients)</label>
        <div class="input-group">
          <input id="authUrlBox" readonly value="${authenticatedUrl}" onclick="this.select()" />
          <button class="btn btn-primary" onclick="copyField('authUrlBox', this)">Copy Authenticated URL</button>
        </div>
        <span class="subtext">Includes <code>?apiKey=...</code> for clients without custom header input fields.</span>
      </div>

      <div class="field">
        <label>🔑 Standalone API Key</label>
        <div class="input-group">
          <input id="keyBox" readonly value="${apiKey}" onclick="this.select()" />
          <button class="btn" onclick="copyField('keyBox', this)">Copy Key</button>
        </div>
      </div>

      <div class="field">
        <label>🌐 Base Web App URL (Without Key)</label>
        <div class="input-group">
          <input id="baseUrlBox" readonly value="${webappUrl}" onclick="this.select()" />
          <button class="btn" onclick="copyField('baseUrlBox', this)">Copy Base URL</button>
        </div>
      </div>
    ` : `
      <div class="banner-open">
        🔓 <strong>Open Access Mode Active (No Sign-in Required)</strong>: The server accepts connections without an API key.<br />
        <span style="font-size: 11px; opacity: 0.9;">Recommended for Claude.ai Custom Connectors.</span>
      </div>

      <div class="field">
        <label>🔗 Connector URL (Open Mode)</label>
        <div class="input-group">
          <input id="openUrlBox" readonly value="${webappUrl}" onclick="this.select()" />
          <button class="btn btn-primary" onclick="copyField('openUrlBox', this)">Copy Connector URL</button>
        </div>
        <span class="subtext">Paste this directly into Claude with "No sign-in required".</span>
      </div>
    `}

    <div class="field">
      <label>Sample cURL Request</label>
      <pre>curl -L -X POST "${authenticatedUrl}" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}'</pre>
    </div>

    <div class="btn-bar">
      <div>
        ${hasKey ? `
          <button class="btn btn-danger" onclick="toggleAuth('disable')">🔓 Switch to Open Mode (Remove Key)</button>
        ` : `
          <button class="btn btn-success" onclick="toggleAuth('enable')">🔒 Generate Key & Enable Auth Mode</button>
        `}
      </div>
      <button class="close-btn" onclick="google.script.host.close()">Done</button>
    </div>

    <script>
      function copyField(elementId, btn) {
        var input = document.getElementById(elementId);
        input.select();
        document.execCommand("copy");
        var origText = btn.innerText;
        btn.innerText = "✓ Copied!";
        btn.style.background = "#15803d";
        btn.style.borderColor = "#16a34a";
        setTimeout(function() {
          btn.innerText = origText;
          btn.style.background = "";
          btn.style.borderColor = "";
        }, 2200);
      }
      function toggleAuth(action) {
        google.script.run
          .withSuccessHandler(function() {
            google.script.host.close();
          })
          .applyToggleAuth(action);
      }
    </script>
  `;

  const htmlOutput = HtmlService.createHtmlOutput(html).setWidth(580).setHeight(hasKey ? 470 : 380);
  ui.showModalDialog(htmlOutput, "🔑 MCP Server URL & Authentication");
}

/**
 * Server handler for toggling API key from modal dialog
 */
function applyToggleAuth(action) {
  if (action === "disable") {
    PropertiesService.getScriptProperties().deleteProperty("API_KEY");
  } else if (action === "enable") {
    const newKey = generateSecureApiKey();
    PropertiesService.getScriptProperties().setProperty("API_KEY", newKey);
  }
}

/**
 * Menu Action: Switch to Open Mode (Remove API Key)
 */
function menuDisableApiKey() {
  const ui = SpreadsheetApp.getUi();
  PropertiesService.getScriptProperties().deleteProperty("API_KEY");
  ui.alert(
    "Open Access Mode Activated",
    "API Key has been removed from Script Properties.\n\nThe server is now in Open Mode (No Sign-in Required). Claude.ai and other connectors can connect directly without authentication.",
    ui.ButtonSet.OK
  );
}

/**
 * Menu Action: Re-generate API Key
 */
function menuRegenerateApiKey() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.alert(
    "Re-generate API Key",
    "Are you sure you want to generate a new API key? Any existing MCP clients using the current key will lose access until updated.",
    ui.ButtonSet.YES_NO
  );

  if (res === ui.Button.YES) {
    const newKey = generateSecureApiKey();
    PropertiesService.getScriptProperties().setProperty("API_KEY", newKey);
    menuShowApiKey();
  }
}

/**
 * Helper to escape HTML characters
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Menu Action: Setup Sheet Tracking Wizard (Interactive Modal Dialog)
 */
function menuSheetSetupWizard() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const activeSheet = SpreadsheetApp.getActiveSheet();
  const activeSheetName = activeSheet.getName();
  const allSheets = ss.getSheets().map(s => s.getName());

  const sheetOptionsHtml = allSheets.map(name => {
    const selected = name === activeSheetName ? " selected" : "";
    return `<option value="${escapeHtml(name)}"${selected}>${escapeHtml(name)}</option>`;
  }).join("");

  const html = `
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f1f5f9; padding: 16px; margin: 0; }
      h3 { margin: 0 0 12px 0; font-size: 15px; color: #60a5fa; }
      .field { margin-bottom: 12px; }
      label.title { display: block; font-size: 11px; font-weight: 600; text-transform: uppercase; color: #94a3b8; margin-bottom: 6px; }
      select, input[type="text"] { width: 100%; box-sizing: border-box; background: #020617; border: 1px solid #334155; border-radius: 6px; padding: 7px 10px; color: #38bdf8; font-family: inherit; font-size: 13px; outline: none; }
      .checkbox-group { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 12px; margin-bottom: 12px; }
      .check-item { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; font-size: 13px; }
      .check-item:last-child { margin-bottom: 0; }
      .check-left { display: flex; align-items: center; gap: 8px; }
      input[type="checkbox"] { accent-color: #3b82f6; width: 16px; height: 16px; cursor: pointer; }
      .col-name-input { width: 130px !important; font-family: monospace !important; font-size: 12px !important; padding: 4px 6px !important; }
      .btn-bar { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
      button { padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; border: none; }
      button.btn-primary { background: #3b82f6; color: white; }
      button.btn-primary:hover { background: #2563eb; }
      button.btn-secondary { background: #334155; color: #cbd5e1; }
      button.btn-secondary:hover { background: #475569; }
      #statusArea { font-size: 12px; margin-top: 10px; min-height: 20px; }
      .status-ok { color: #86efac; font-weight: 600; }
      .status-err { color: #f87171; font-weight: 600; }
    </style>
    <h3>🛠️ Setup System Tracking Columns</h3>
    <div class="field">
      <label class="title">Target Sheet</label>
      <select id="targetSheet">
        ${sheetOptionsHtml}
        <option value="__ALL__">🌐 ALL Sheets in Spreadsheet</option>
      </select>
    </div>

    <label class="title">Tracking Columns to Add / Ensure</label>
    <div class="checkbox-group">
      <div class="check-item">
        <label class="check-left">
          <input type="checkbox" id="chkUid" checked />
          <span><strong>🆔 Unique Record ID</strong></span>
        </label>
        <input type="text" id="nameUid" class="col-name-input" value="_uid" title="Column Header Name" />
      </div>
      <div class="check-item">
        <label class="check-left">
          <input type="checkbox" id="chkUpdated" checked />
          <span><strong>🕒 Last Modified Timestamp</strong></span>
        </label>
        <input type="text" id="nameUpdated" class="col-name-input" value="_updated_at" title="Column Header Name" />
      </div>
      <div class="check-item">
        <label class="check-left">
          <input type="checkbox" id="chkCreated" checked />
          <span><strong>📅 Created Timestamp</strong></span>
        </label>
        <input type="text" id="nameCreated" class="col-name-input" value="_created_at" title="Column Header Name" />
      </div>
    </div>

    <div class="checkbox-group" style="padding: 10px 12px;">
      <div class="check-item" style="margin-bottom: 8px;">
        <label class="check-left">
          <input type="checkbox" id="chkBackfill" checked />
          <span>🔄 Backfill existing rows with unique IDs & timestamps</span>
        </label>
      </div>
      <div class="check-item">
        <label class="check-left">
          <input type="checkbox" id="chkFreeze" checked />
          <span>📌 Freeze header row (Row 1)</span>
        </label>
      </div>
    </div>

    <div id="statusArea"></div>

    <div class="btn-bar">
      <button class="btn-secondary" onclick="google.script.host.close()">Cancel</button>
      <button class="btn-primary" id="btnApply" onclick="applySetup()">Apply Setup</button>
    </div>

    <script>
      function applySetup() {
        var btn = document.getElementById("btnApply");
        var status = document.getElementById("statusArea");
        btn.disabled = true;
        btn.innerText = "Applying...";
        status.innerHTML = '<span style="color: #60a5fa;">⏳ Configuring columns and backfilling rows...</span>';

        var config = {
          sheetName: document.getElementById("targetSheet").value,
          includeUid: document.getElementById("chkUid").checked,
          idColumnName: document.getElementById("nameUid").value.trim() || "_uid",
          includeUpdatedAt: document.getElementById("chkUpdated").checked,
          updatedAtColumnName: document.getElementById("nameUpdated").value.trim() || "_updated_at",
          includeCreatedAt: document.getElementById("chkCreated").checked,
          createdAtColumnName: document.getElementById("nameCreated").value.trim() || "_created_at",
          backfillExisting: document.getElementById("chkBackfill").checked,
          freezeHeader: document.getElementById("chkFreeze").checked
        };

        google.script.run
          .withSuccessHandler(function(res) {
            btn.disabled = false;
            btn.innerText = "Done";
            status.innerHTML = '<span class="status-ok">✓ ' + (res.message || 'Setup applied successfully!') + '</span>';
            setTimeout(function() { google.script.host.close(); }, 2200);
          })
          .withFailureHandler(function(err) {
            btn.disabled = false;
            btn.innerText = "Retry";
            status.innerHTML = '<span class="status-err">❌ Error: ' + err.message + '</span>';
          })
          .applySheetSetupFromWizard(config);
      }
    </script>
  `;

  const htmlOutput = HtmlService.createHtmlOutput(html).setWidth(490).setHeight(470);
  ui.showModalDialog(htmlOutput, "✨ Sheet Tracking Setup Wizard");
}

/**
 * Server-side handler for the setup wizard modal.
 */
function applySheetSetupFromWizard(config) {
  if (config.sheetName === "__ALL__") {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheets = ss.getSheets();
    let totalColsAdded = 0;
    let totalBackfilled = 0;
    const sheetResults = [];

    for (const s of sheets) {
      const sName = s.getName();
      const res = toolSetupSheetSystemColumns({
        sheetName: sName,
        includeUid: config.includeUid,
        idColumnName: config.idColumnName,
        includeUpdatedAt: config.includeUpdatedAt,
        updatedAtColumnName: config.updatedAtColumnName,
        includeCreatedAt: config.includeCreatedAt,
        createdAtColumnName: config.createdAtColumnName,
        backfillExisting: config.backfillExisting,
        freezeHeader: config.freezeHeader
      });
      totalColsAdded += (res.columnsAdded || []).length;
      totalBackfilled += (res.rowsBackfilled || 0);
      sheetResults.push(sName);
    }
    return {
      success: true,
      message: "Configured " + sheetResults.length + " sheets (Added " + totalColsAdded + " columns, backfilled " + totalBackfilled + " rows)."
    };
  } else {
    const res = toolSetupSheetSystemColumns({
      sheetName: config.sheetName,
      includeUid: config.includeUid,
      idColumnName: config.idColumnName,
      includeUpdatedAt: config.includeUpdatedAt,
      updatedAtColumnName: config.updatedAtColumnName,
      includeCreatedAt: config.includeCreatedAt,
      createdAtColumnName: config.createdAtColumnName,
      backfillExisting: config.backfillExisting,
      freezeHeader: config.freezeHeader
    });
    const addedStr = (res.columnsAdded && res.columnsAdded.length > 0) ? res.columnsAdded.join(", ") : "None (already existed)";
    return {
      success: true,
      message: "Sheet '" + config.sheetName + "': added [" + addedStr + "], backfilled " + res.rowsBackfilled + " rows."
    };
  }
}

/**
 * Menu Action: Add All Tracking Columns (_uid, _updated_at, _created_at) to Active Sheet
 */
function menuAddAllTrackingColumns() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSheet();
  const sheetName = sheet.getName();

  try {
    const result = toolSetupSheetSystemColumns({
      sheetName: sheetName,
      includeUid: true,
      includeUpdatedAt: true,
      includeCreatedAt: true,
      freezeHeader: true,
      backfillExisting: true
    });

    const addedMsg = result.columnsAdded.length > 0 ? result.columnsAdded.join(", ") : "None (already existed)";
    ui.alert(
      "All Tracking Columns Configured",
      "Sheet: " + sheetName +
      "\nColumns Added: " + addedMsg +
      "\nRows Backfilled: " + result.rowsBackfilled + " of " + result.totalRows +
      "\n\nNote: The onEdit trigger will automatically maintain UIDs and update timestamps when rows are edited.",
      ui.ButtonSet.OK
    );
  } catch (err) {
    ui.alert("Error", "Failed to setup system columns: " + err.message, ui.ButtonSet.OK);
  }
}

/**
 * Menu Action: Add UID Column (_uid) to Active Sheet
 */
function menuAddUidColumn() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSheet();
  const sheetName = sheet.getName();

  try {
    const result = toolSetupSheetSystemColumns({
      sheetName: sheetName,
      includeUid: true,
      includeUpdatedAt: false,
      includeCreatedAt: false,
      backfillExisting: true
    });

    const added = result.columnsAdded.includes("_uid");
    ui.alert(
      "UID Column Status",
      "Sheet: " + sheetName +
      (added ? "\nAdded Column: _uid" : "\nColumn '_uid' already existed.") +
      "\nRows Backfilled: " + result.rowsBackfilled + " of " + result.totalRows,
      ui.ButtonSet.OK
    );
  } catch (err) {
    ui.alert("Error", "Failed to add UID column: " + err.message, ui.ButtonSet.OK);
  }
}

/**
 * Menu Action: Add Updated At Column (_updated_at) to Active Sheet
 */
function menuAddUpdatedAtColumn() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSheet();
  const sheetName = sheet.getName();

  try {
    const result = toolSetupSheetSystemColumns({
      sheetName: sheetName,
      includeUid: false,
      includeUpdatedAt: true,
      includeCreatedAt: false,
      backfillExisting: true
    });

    const added = result.columnsAdded.includes("_updated_at");
    ui.alert(
      "Updated At Column Status",
      "Sheet: " + sheetName +
      (added ? "\nAdded Column: _updated_at" : "\nColumn '_updated_at' already existed.") +
      "\nRows Backfilled: " + result.rowsBackfilled + " of " + result.totalRows +
      "\n\nNote: Edits to this sheet will now automatically update the '_updated_at' timestamp on the modified row.",
      ui.ButtonSet.OK
    );
  } catch (err) {
    ui.alert("Error", "Failed to add Updated At column: " + err.message, ui.ButtonSet.OK);
  }
}

/**
 * Menu Action: Add Created At Column (_created_at) to Active Sheet
 */
function menuAddCreatedAtColumn() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSheet();
  const sheetName = sheet.getName();

  try {
    const result = toolSetupSheetSystemColumns({
      sheetName: sheetName,
      includeUid: false,
      includeUpdatedAt: false,
      includeCreatedAt: true,
      backfillExisting: true
    });

    const added = result.columnsAdded.includes("_created_at");
    ui.alert(
      "Created At Column Status",
      "Sheet: " + sheetName +
      (added ? "\nAdded Column: _created_at" : "\nColumn '_created_at' already existed.") +
      "\nRows Backfilled: " + result.rowsBackfilled + " of " + result.totalRows,
      ui.ButtonSet.OK
    );
  } catch (err) {
    ui.alert("Error", "Failed to add Created At column: " + err.message, ui.ButtonSet.OK);
  }
}

/**
 * Menu Action: Backfill Missing UIDs on Active Sheet
 */
function menuBackfillUids() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSheet();
  const sheetName = sheet.getName();

  try {
    const lastCol = sheet.getLastColumn();
    const lastRow = sheet.getLastRow();
    if (lastCol === 0 || lastRow <= 1) {
      ui.alert("Backfill UIDs", "No data rows found on sheet '" + sheetName + "'.", ui.ButtonSet.OK);
      return;
    }

    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    let uidColIdx = -1;
    for (let c = 0; c < headers.length; c++) {
      const h = String(headers[c]).trim().toLowerCase();
      if (h === "_uid" || h === "uid" || h === "id") {
        uidColIdx = c + 1;
        break;
      }
    }

    if (uidColIdx === -1) {
      const ask = ui.alert(
        "No UID Column Found",
        "Sheet '" + sheetName + "' does not have a UID column (_uid).\n\nWould you like to add the '_uid' column and backfill all rows now?",
        ui.ButtonSet.YES_NO
      );
      if (ask === ui.Button.YES) {
        menuAddUidColumn();
      }
      return;
    }

    const dataRowCount = lastRow - 1;
    const uidRange = sheet.getRange(2, uidColIdx, dataRowCount, 1);
    const uidValues = uidRange.getValues();
    let backfilled = 0;

    for (let r = 0; r < dataRowCount; r++) {
      const val = uidValues[r][0];
      if (!val || String(val).trim() === "") {
        uidValues[r][0] = "rec_" + Utilities.getUuid().substring(0, 8);
        backfilled++;
      }
    }

    if (backfilled > 0) {
      uidRange.setValues(uidValues);
      SpreadsheetApp.flush();
    }

    ui.alert(
      "UID Backfill Complete",
      "Sheet: " + sheetName +
      "\nRows Checked: " + dataRowCount +
      "\nMissing UIDs Backfilled: " + backfilled,
      ui.ButtonSet.OK
    );
  } catch (err) {
    ui.alert("Error", "Error backfilling UIDs: " + err.message, ui.ButtonSet.OK);
  }
}

/**
 * Menu Action: Backfill Missing Timestamps on Active Sheet
 */
function menuBackfillTimestamps() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSheet();
  const sheetName = sheet.getName();

  try {
    const lastCol = sheet.getLastColumn();
    const lastRow = sheet.getLastRow();
    if (lastCol === 0 || lastRow <= 1) {
      ui.alert("Backfill Timestamps", "No data rows found on sheet '" + sheetName + "'.", ui.ButtonSet.OK);
      return;
    }

    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    let createdColIdx = -1;
    let updatedColIdx = -1;

    for (let c = 0; c < headers.length; c++) {
      const h = String(headers[c]).trim().toLowerCase();
      if (createdColIdx === -1 && (h === "_created_at" || h === "created_at" || h === "created at" || h === "created date")) {
        createdColIdx = c + 1;
      }
      if (updatedColIdx === -1 && (h === "_updated_at" || h === "updated_at" || h === "updated at" || h === "edited date" || h === "last modified")) {
        updatedColIdx = c + 1;
      }
    }

    if (createdColIdx === -1 && updatedColIdx === -1) {
      const ask = ui.alert(
        "No Timestamp Columns Found",
        "Sheet '" + sheetName + "' does not have '_created_at' or '_updated_at' columns.\n\nWould you like to add tracking columns now?",
        ui.ButtonSet.YES_NO
      );
      if (ask === ui.Button.YES) {
        menuAddAllTrackingColumns();
      }
      return;
    }

    const dataRowCount = lastRow - 1;
    const nowIso = new Date().toISOString();
    let createdFilled = 0;
    let updatedFilled = 0;

    if (createdColIdx !== -1) {
      const rng = sheet.getRange(2, createdColIdx, dataRowCount, 1);
      const vals = rng.getValues();
      for (let r = 0; r < dataRowCount; r++) {
        if (!vals[r][0] || String(vals[r][0]).trim() === "") {
          vals[r][0] = nowIso;
          createdFilled++;
        }
      }
      if (createdFilled > 0) rng.setValues(vals);
    }

    if (updatedColIdx !== -1) {
      const rng = sheet.getRange(2, updatedColIdx, dataRowCount, 1);
      const vals = rng.getValues();
      for (let r = 0; r < dataRowCount; r++) {
        if (!vals[r][0] || String(vals[r][0]).trim() === "") {
          vals[r][0] = nowIso;
          updatedFilled++;
        }
      }
      if (updatedFilled > 0) rng.setValues(vals);
    }

    SpreadsheetApp.flush();

    ui.alert(
      "Timestamp Backfill Complete",
      "Sheet: " + sheetName +
      "\nRows Checked: " + dataRowCount +
      "\nCreated Timestamps Filled: " + createdFilled +
      "\nUpdated Timestamps Filled: " + updatedFilled,
      ui.ButtonSet.OK
    );
  } catch (err) {
    ui.alert("Error", "Error backfilling timestamps: " + err.message, ui.ButtonSet.OK);
  }
}

/**
 * Menu Action: Setup System Columns on Active Sheet (Legacy backward compatibility)
 */
function menuSetupSystemColumnsActiveSheet() {
  menuAddAllTrackingColumns();
}

/**
 * Menu Action: Setup System Columns on All Sheets
 */
function menuSetupSystemColumnsAllSheets() {
  const ui = SpreadsheetApp.getUi();
  const confirm = ui.alert(
    "Setup System Columns on All Sheets",
    "This will inspect ALL sheet tabs in this spreadsheet, adding '_uid', '_created_at', and '_updated_at' if missing, and backfilling rows.\n\nProceed?",
    ui.ButtonSet.YES_NO
  );

  if (confirm !== ui.Button.YES) return;

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheets = ss.getSheets();
    const summary = [];

    for (const s of sheets) {
      const sName = s.getName();
      const res = toolSetupSheetSystemColumns({ sheetName: sName });
      summary.push(sName + ": added [" + (res.columnsAdded.join(", ") || "none") + "], backfilled " + res.rowsBackfilled + " rows");
    }

    ui.alert("All Sheets Configured", summary.join("\n"), ui.ButtonSet.OK);
  } catch (err) {
    ui.alert("Error", "Error configuring sheets: " + err.message, ui.ButtonSet.OK);
  }
}

/**
 * Menu Action: Documentation & Connection Guide
 */
function menuShowDocumentation() {
  const ui = SpreadsheetApp.getUi();
  const webappUrl = getWebappUrl();
  const apiKey = PropertiesService.getScriptProperties().getProperty("API_KEY") || "(Click 'View API Key' to generate)";
  const tools = getToolDefinitions();

  const toolRows = tools.map(t => `
    <tr>
      <td style="padding: 8px; border-bottom: 1px solid #334155; font-family: monospace; color: #60a5fa; font-weight: 600;">${t.name}</td>
      <td style="padding: 8px; border-bottom: 1px solid #334155; font-size: 12px; color: #cbd5e1;">${t.description}</td>
    </tr>
  `).join("");

  const html = `
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f1f5f9; padding: 16px; margin: 0; }
      h3 { margin: 16px 0 8px 0; font-size: 15px; color: #60a5fa; }
      pre { background: #020617; border: 1px solid #334155; border-radius: 6px; padding: 10px; font-size: 12px; color: #38bdf8; overflow-x: auto; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; }
      th { text-align: left; padding: 8px; background: #1e293b; color: #94a3b8; font-size: 11px; text-transform: uppercase; }
      .badge { display: inline-block; background: #15803d; color: #bbf7d0; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
      button { background: #3b82f6; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; float: right; margin-top: 12px; }
      button:hover { background: #2563eb; }
    </style>

    <div style="display: flex; justify-content: space-between; align-items: center;">
      <h2 style="margin: 0; font-size: 18px;">Google Sheets MCP Server Documentation</h2>
      <span class="badge">Version 1.0.0</span>
    </div>

    <h3>1. MCP Endpoint & Authentication</h3>
    <pre>URL:     ${webappUrl}
API Key: ${apiKey}</pre>

    <h3>2. Claude Desktop / Cursor MCP Configuration</h3>
    <p style="font-size: 12px; color: #cbd5e1; margin: 4px 0;">Add this to your MCP settings or use standard Streamable HTTP / JSON-RPC:</p>
    <pre>{
  "mcpServers": {
    "google-sheets": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-proxy",
        "--transport",
        "http",
        "${webappUrl}?apiKey=${apiKey}"
      ]
    }
  }
}</pre>

    <h3>3. Direct JSON-RPC 2.0 Call Example</h3>
    <pre>POST ${webappUrl}?apiKey=${apiKey}
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "get_filtered_sheet_contents",
    "arguments": {
      "sheetName": "Companies",
      "filters": { "Industry": "Technology" },
      "limit": 5
    }
  }
}</pre>

    <h3>4. Available MCP Tools (${tools.length})</h3>
    <table>
      <thead>
        <tr>
          <th>Tool Name</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        ${toolRows}
      </tbody>
    </table>

    <button onclick="google.script.host.close()">Close</button>
  `;

  const htmlOutput = HtmlService.createHtmlOutput(html).setWidth(620).setHeight(520);
  ui.showModalDialog(htmlOutput, "📖 MCP Server Documentation");
}

