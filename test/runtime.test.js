import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AppServerRuntime, normalizeSessionKey, SessionStore } from "../bridge/app-server-runtime.js";

test("streams readable reasoning summaries without exposing raw reasoning", () => {
  const runtime = new AppServerRuntime();
  const events = [];
  runtime.turnListeners.set("turn-1", (event) => events.push(event));

  runtime.handleLine(
    JSON.stringify({
      method: "item/reasoning/summaryTextDelta",
      params: { turnId: "turn-1", delta: "检查当前 Cell" }
    })
  );
  runtime.handleLine(
    JSON.stringify({
      method: "item/reasoning/textDelta",
      params: { turnId: "turn-1", delta: "raw hidden reasoning" }
    })
  );

  assert.deepEqual(events, [{ type: "reasoning_delta", delta: "检查当前 Cell" }]);
});

test("streams and retains task lifecycle and plan updates", () => {
  const runtime = new AppServerRuntime();
  const events = [];
  runtime.turnListeners.set("turn-1", (event) => events.push(event));

  runtime.handleLine(
    JSON.stringify({ method: "item/started", params: { turnId: "turn-1", item: { type: "reasoning" } } })
  );
  runtime.handleLine(
    JSON.stringify({
      method: "turn/plan/updated",
      params: { turnId: "turn-1", plan: [{ step: "检查聚合逻辑", status: "inProgress" }] }
    })
  );
  runtime.handleLine(
    JSON.stringify({
      method: "item/completed",
      params: { turnId: "turn-1", item: { type: "reasoning", summary: [{ text: "聚合列需要显式命名" }] } }
    })
  );

  assert.deepEqual(events, [
    { type: "task", message: "开始分析代码与上下文" },
    { type: "plan", plan: [{ step: "检查聚合逻辑", status: "inProgress" }] },
    { type: "reasoning_delta", delta: "聚合列需要显式命名" },
    { type: "task", message: "代码与上下文分析完成" }
  ]);
});

test("concurrent callers wait for app-server initialization", async () => {
  const runtime = new AppServerRuntime();
  let finishStartup;
  let secondFinished = false;
  runtime.startProcess = async function () {
    this.child = { killed: false };
    await new Promise((resolve) => {
      finishStartup = resolve;
    });
    this.serverInfo = { userAgent: "test" };
  };

  const first = runtime.start();
  const second = runtime.start().then(() => {
    secondFinished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondFinished, false);
  finishStartup();
  await Promise.all([first, second]);
  assert.equal(secondFinished, true);
});

test("times out unanswered app-server RPCs and clears pending state", async () => {
  const runtime = new AppServerRuntime({ rpcTimeoutMs: 10 });
  runtime.child = { stdin: { writable: true, write() {} } };

  await assert.rejects(runtime.rawRequest("thread/start", {}), /request timed out: thread\/start/);
  assert.equal(runtime.pending.size, 0);
});

test("normalizes notebook URLs without fragment-only UI state", () => {
  assert.equal(
    normalizeSessionKey("https://console.volcengine.com/notebook/42?project=7#cell-3"),
    "https://console.volcengine.com/notebook/42?project=7"
  );
  assert.equal(normalizeSessionKey("private-notebook-key"), "private-notebook-key");
  assert.throws(() => normalizeSessionKey(""), /session key/i);
});

test("removes credentials and volatile parameters from notebook session keys", () => {
  assert.equal(
    normalizeSessionKey(
      "https://lab.dataleap.volces.com/region/lab?path=42.ipynb&token=secret&username=user&autoRefresh=123"
    ),
    "https://lab.dataleap.volces.com/region/lab?path=42.ipynb"
  );
});

test("persists notebook-to-thread mappings", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "doradude-store-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.set("notebook-a", { threadId: "thread-1" });

  const restored = new SessionStore(root);
  await restored.load();
  assert.deepEqual(restored.get("notebook-a"), { threadId: "thread-1" });
  assert.equal(restored.size, 1);
  assert.match(await readFile(path.join(root, "sessions.json"), "utf8"), /thread-1/);

  await restored.delete("notebook-a");
  assert.equal(restored.size, 0);
});

test("migrates stored session keys that contain URL credentials", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "doradude-store-migration-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "sessions.json"),
    JSON.stringify({
      "https://lab.dataleap.volces.com/lab?path=42.ipynb&token=secret": { threadId: "thread-1" }
    })
  );

  const store = new SessionStore(root);
  await store.load();
  assert.deepEqual(store.get("https://lab.dataleap.volces.com/lab?path=42.ipynb"), { threadId: "thread-1" });
  assert.doesNotMatch(await readFile(path.join(root, "sessions.json"), "utf8"), /secret|token=/);
});
