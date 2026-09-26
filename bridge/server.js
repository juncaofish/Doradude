import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { AppServerRuntime } from "./app-server-runtime.js";
import { validateRequest } from "./codex-runner.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer(parseConfig(process.argv.slice(2), process.env));
}

export function startServer(config) {
  assertSafeConfig(config);
  const runtime = new AppServerRuntime({
    binary: config.codexBinary,
    model: config.model,
    timeoutMs: config.timeoutMs,
    stateRoot: config.stateRoot
  });
  const server = createServer(async (request, response) => {
    setCorsHeaders(request, response, config.allowedOrigins);
    if (request.method === "OPTIONS") return sendJson(response, 204, null);

    try {
      authenticate(request, config.token);

      if (request.method === "GET" && request.url === "/health") {
        return sendJson(response, 200, await runtime.health());
      }

      if (request.method === "POST" && request.url === "/v1/codex") {
        let body;
        try {
          body = validateRequest(await readJson(request));
        } catch (error) {
          error.statusCode ||= 400;
          throw error;
        }
        const result = await runtime.run(body);
        return sendJson(response, 200, result);
      }

      if (request.method === "POST" && request.url === "/v1/codex/stream") {
        let body;
        try {
          body = validateRequest(await readJson(request));
        } catch (error) {
          error.statusCode ||= 400;
          throw error;
        }
        return streamCodex(response, runtime, body);
      }

      if (request.method === "POST" && request.url === "/v1/session/reset") {
        const body = await readJson(request);
        if (typeof body.sessionKey !== "string") {
          const error = new Error("sessionKey is required");
          error.statusCode = 400;
          throw error;
        }
        return sendJson(response, 200, await runtime.reset(body.sessionKey));
      }

      return sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const status = error.statusCode || 500;
      console.error(`[doradude] ${request.method} ${request.url}: ${error.message}`);
      return sendJson(response, status, { error: status === 500 ? "Codex request failed" : error.message });
    }
  });

  server.listen(config.port, config.host, () => {
    console.log(`Doradude Codex Bridge listening on http://${config.host}:${config.port}`);
    console.log(`Codex binary: ${config.codexBinary}${config.model ? ` · model: ${config.model}` : ""}`);
  });
  server.on("error", (error) => {
    const detail = error.code === "EADDRINUSE"
      ? `Port ${config.port} is already in use`
      : `${error.code || "listen error"}: ${error.message}`;
    console.error(`[doradude] Unable to listen on http://${config.host}:${config.port}: ${detail}`);
  });
  server.on("close", () => runtime.stop());
  return server;
}

export function parseConfig(args, env) {
  const flags = new Map();
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index].startsWith("--") || args[index + 1] === undefined) {
      throw new Error(`Invalid argument: ${args[index]}`);
    }
    flags.set(args[index].slice(2), args[index + 1]);
  }
  return {
    host: flags.get("host") || env.DORADUDE_HOST || "127.0.0.1",
    port: numberInRange(flags.get("port") || env.DORADUDE_PORT || "4344", 1, 65535, "port"),
    token: flags.get("token") || env.DORADUDE_TOKEN || "",
    codexBinary: flags.get("codex-bin") || env.DORADUDE_CODEX_BIN || "codex",
    model: flags.get("model") || env.DORADUDE_CODEX_MODEL || "",
    stateRoot: flags.get("state-dir") || env.DORADUDE_STATE_DIR || undefined,
    timeoutMs: numberInRange(env.DORADUDE_TIMEOUT_MS || "150000", 1000, 600000, "timeout"),
    allowedOrigins: new Set(
      (env.DORADUDE_ALLOWED_ORIGINS || "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean)
    )
  };
}

function assertSafeConfig(value) {
  if (!isLoopback(value.host) && !value.token) {
    throw new Error("DORADUDE_TOKEN is required when listening on a non-loopback address");
  }
}

function authenticate(request, token) {
  if (!token) return;
  if (request.headers.authorization !== `Bearer ${token}`) {
    const error = new Error("Unauthorized");
    error.statusCode = 401;
    throw error;
  }
}

function setCorsHeaders(request, response, allowedOrigins) {
  const origin = request.headers.origin || "";
  const allowed = origin.startsWith("chrome-extension://") || allowedOrigins.has(origin);
  if (allowed) response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function readJson(request, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error("Request body is too large");
        error.statusCode = 413;
        reject(error);
        request.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        const error = new Error("Request body must be valid JSON");
        error.statusCode = 400;
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, value) {
  response.statusCode = status;
  if (status === 204) return response.end();
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

async function streamCodex(response, runtime, body) {
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  const send = (event) => response.write(`${JSON.stringify(event)}\n`);
  try {
    const result = await runtime.run(body, send);
    send({ type: "result", data: result });
  } catch (error) {
    console.error(`[doradude] POST /v1/codex/stream: ${error.message}`);
    send({ type: "error", error: "Codex request failed" });
  } finally {
    response.end();
  }
}

function numberInRange(raw, min, max, name) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}: ${raw}`);
  return value;
}

function isLoopback(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
