import { createInterface } from "node:readline";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type RequestHandler = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

// JSON-RPC 2.0 notifications are messages without an `id` field. The spec
// (and the MCP transport contract) requires the server to NOT send a
// response for notifications. Some clients tolerate spurious responses;
// stricter clients (e.g. Codex CLI) treat them as protocol violations and
// close the transport. See agentmemory#129.
function isNotification(req: JsonRpcRequest): boolean {
  return req.id === undefined || req.id === null;
}

// Per JSON-RPC 2.0 §4, a valid request id must be a String, Number, or Null
// (Null is technically only allowed in responses; in requests, omitting id
// is the convention for notifications, which we treat the same as null).
// Any other runtime type (object, array, boolean) is an Invalid Request.
function isValidId(id: unknown): id is string | number | null | undefined {
  return (
    id === undefined ||
    id === null ||
    typeof id === "string" ||
    typeof id === "number"
  );
}

// Exported for unit tests so the line-handling logic is exercised
// independently of process.stdin / process.stdout.
export async function processLine(
  line: string,
  handler: RequestHandler,
  writeOut: (response: JsonRpcResponse) => void,
  writeErr: (msg: string) => void = (msg) => process.stderr.write(msg),
): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    writeOut({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    return;
  }

  const request = parsed as JsonRpcRequest;
  const rawId = (request as { id?: unknown } | null)?.id;

  // Invalid request shape (missing/wrong jsonrpc, non-string method).
  if (
    !request ||
    typeof request !== "object" ||
    request.jsonrpc !== "2.0" ||
    typeof request.method !== "string"
  ) {
    // Echo the id back only if it's a valid string/number. Notifications
    // (missing/null id) and malformed ids both drop silently — we don't
    // want to respond to something that could be a notification, and we
    // can't invent an id for a malformed one.
    if (typeof rawId === "string" || typeof rawId === "number") {
      writeOut({
        jsonrpc: "2.0",
        id: rawId,
        error: { code: -32600, message: "Invalid Request" },
      });
    }
    return;
  }

  // Request shape is valid but id may still be of the wrong type
  // (object, array, boolean). Per the spec, that's an Invalid Request.
  // Respond with id: null because we can't safely echo a non-JSON-RPC id.
  if (!isValidId(rawId)) {
    writeOut({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request: id must be string, number, or null" },
    });
    return;
  }

  const notification = isNotification(request);

  try {
    const result = await handler(request.method, request.params || {});
    if (notification) return;
    writeOut({
      jsonrpc: "2.0",
      id: request.id as string | number,
      result,
    });
  } catch (err) {
    if (notification) {
      writeErr(
        `[mcp-transport] notification handler error for ${request.method}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      return;
    }
    writeOut({
      jsonrpc: "2.0",
      id: request.id as string | number,
      error: {
        code: -32603,
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

export function createStdioTransport(handler: RequestHandler): {
  start: () => void;
  stop: () => void;
} {
  let rl: ReturnType<typeof createInterface> | null = null;

  const writeResponse = (response: JsonRpcResponse) => {
    process.stdout.write(JSON.stringify(response) + "\n");
  };

  const onLine = (line: string) => processLine(line, handler, writeResponse);

  return {
    start() {
      rl = createInterface({ input: process.stdin });
      rl.on("line", onLine);
    },
    stop() {
      rl?.close();
      rl = null;
    },
  };
}
