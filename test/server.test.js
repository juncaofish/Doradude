import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../bridge/server.js";

test("uses loopback and app-server defaults", () => {
  const config = parseConfig([], {});
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 4344);
  assert.equal(config.codexBinary, "codex");
  assert.equal(config.token, "");
});

test("accepts remote runtime configuration", () => {
  const config = parseConfig(["--host", "0.0.0.0", "--port", "4545", "--model", "model-x"], {
    DORADUDE_TOKEN: "secret"
  });
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 4545);
  assert.equal(config.model, "model-x");
  assert.equal(config.token, "secret");
});

test("rejects invalid numeric configuration", () => {
  assert.throws(() => parseConfig(["--port", "70000"], {}), /Invalid port/);
});
