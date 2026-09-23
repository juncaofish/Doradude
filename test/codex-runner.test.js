import assert from "node:assert/strict";
import test from "node:test";
import { buildPrompt, validateRequest, validateResponse } from "../bridge/codex-runner.js";

const payload = {
  action: "fix",
  instruction: "Fix the failing cell",
  context: {
    notebook: { title: "Example", url: "https://example.test/notebook/1", totalCells: 1 },
    currentCell: { source: "print(missing)", output: "NameError: missing" },
    previousCells: [],
    nextCells: []
  }
};

test("validates and serializes notebook context as untrusted data", () => {
  assert.equal(validateRequest(payload), payload);
  const prompt = buildPrompt(payload);
  assert.match(prompt, /untrusted data/);
  assert.match(prompt, /NameError: missing/);
  assert.match(prompt, /complete corrected current cell/);
});

test("does not send notebook URL credentials to Codex", () => {
  const prompt = buildPrompt({
    ...payload,
    context: {
      ...payload.context,
      notebook: {
        ...payload.context.notebook,
        url: "https://lab.dataleap.volces.com/lab?path=1.ipynb&token=secret&username=user"
      }
    }
  });
  assert.match(prompt, /path=1\.ipynb/);
  assert.doesNotMatch(prompt, /secret|username|token=/);
});

test("rejects unsupported actions and missing cell context", () => {
  assert.throws(() => validateRequest({ ...payload, action: "run" }), /Unsupported action/);
  assert.throws(() => validateRequest({ ...payload, context: {} }), /Current cell context/);
});

test("requires code for replacement responses", () => {
  assert.deepEqual(
    validateResponse({ mode: "replace", summary: "Fixed", code: "print(value)", explanation: null }),
    { mode: "replace", summary: "Fixed", code: "print(value)", explanation: null }
  );
  assert.throws(
    () => validateResponse({ mode: "replace", summary: "Fixed", code: null, explanation: null }),
    /requires code/
  );
});
