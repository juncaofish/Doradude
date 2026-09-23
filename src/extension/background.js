const DEFAULT_SETTINGS = Object.freeze({
  endpoint: "http://127.0.0.1:4343",
  neighborCells: 2,
  customCellSelector: "",
  theme: "light",
  requestTimeoutMs: 180000
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const current = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set(current);
  if (reason === "install") {
    await chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "DORADUDE_GET_SETTINGS") {
    chrome.storage.sync.get(DEFAULT_SETTINGS).then(sendResponse);
    return true;
  }

  if (message?.type === "DORADUDE_OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "DORADUDE_SET_THEME") {
    const theme = message.theme === "dark" ? "dark" : "light";
    chrome.storage.sync
      .set({ theme })
      .then(() => sendResponse({ ok: true, theme }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "DORADUDE_BRIDGE_REQUEST") {
    callBridge(message.path, message.method, message.body)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "DORADUDE_BRIDGE_STREAM") {
    callBridgeStream(message.path, message.method, message.body, (event) => {
      if (!sender.tab?.id) return;
      chrome.tabs
        .sendMessage(
          sender.tab.id,
          { type: "DORADUDE_BRIDGE_STREAM_EVENT", requestId: message.requestId, event },
          { frameId: sender.frameId }
        )
        .catch(() => {});
    })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "DORADUDE_FRAME_EVENT") {
    if (!sender.tab?.id || !sender.frameId) return false;
    chrome.tabs
      .sendMessage(
        sender.tab.id,
        { ...message, type: "DORADUDE_PORTAL_EVENT", frameId: sender.frameId },
        { frameId: 0 }
      )
      .catch(() => {});
    return false;
  }

  if (message?.type === "DORADUDE_PORTAL_COMMAND") {
    if (!sender.tab?.id || sender.frameId !== 0 || !Number.isInteger(message.targetFrameId)) {
      sendResponse({ ok: false, error: "Invalid frame command" });
      return false;
    }
    chrome.tabs
      .sendMessage(
        sender.tab.id,
        {
          type: "DORADUDE_FRAME_COMMAND",
          command: message.command,
          cellId: message.cellId,
          payload: message.payload
        },
        { frameId: message.targetFrameId }
      )
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

async function callBridge(path, method = "GET", body) {
  const [settings, secrets] = await Promise.all([
    chrome.storage.sync.get(DEFAULT_SETTINGS),
    chrome.storage.local.get({ token: "" })
  ]);
  const endpoint = normalizeEndpoint(settings.endpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.requestTimeoutMs);

  try {
    const response = await fetch(`${endpoint}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(secrets.token ? { Authorization: `Bearer ${secrets.token}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `Bridge returned HTTP ${response.status}`);
    }
    return payload;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Codex request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function callBridgeStream(path, method = "POST", body, onEvent) {
  const [settings, secrets] = await Promise.all([
    chrome.storage.sync.get(DEFAULT_SETTINGS),
    chrome.storage.local.get({ token: "" })
  ]);
  const endpoint = normalizeEndpoint(settings.endpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.requestTimeoutMs);

  try {
    const response = await fetch(`${endpoint}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(secrets.token ? { Authorization: `Bearer ${secrets.token}` } : {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Bridge returned HTTP ${response.status}`);
    }
    if (!response.body) throw new Error("Bridge did not return a stream");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let result;
    while (true) {
      const { done, value } = await reader.read();
      buffered += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffered.split("\n");
      buffered = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === "result") result = event.data;
        else if (event.type === "error") throw new Error(event.error || "Codex request failed");
        else onEvent(event);
      }
      if (done) break;
    }
    if (buffered.trim()) {
      const event = JSON.parse(buffered);
      if (event.type === "result") result = event.data;
      else if (event.type === "error") throw new Error(event.error || "Codex request failed");
      else onEvent(event);
    }
    if (!result) throw new Error("Codex stream ended without a result");
    return result;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Codex request timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeEndpoint(value) {
  const parsed = new URL(String(value || DEFAULT_SETTINGS.endpoint));
  return parsed.origin + parsed.pathname.replace(/\/$/, "");
}
