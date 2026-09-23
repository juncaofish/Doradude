const DEFAULTS = {
  endpoint: "http://127.0.0.1:4343",
  token: "",
  neighborCells: 2,
  customCellSelector: "",
  requestTimeoutMs: 180000
};

const form = document.querySelector("#settings-form");
const testButton = document.querySelector("#test");
const connectionStatus = document.querySelector("#connection-status");
const saveStatus = document.querySelector("#save-status");

restore();
form.addEventListener("submit", save);
testButton.addEventListener("click", testConnection);

async function restore() {
  const [settings, secrets] = await Promise.all([
    chrome.storage.sync.get(DEFAULTS),
    chrome.storage.local.get({ token: "" })
  ]);
  settings.token = secrets.token;
  for (const [key, value] of Object.entries(settings)) {
    if (form.elements[key]) form.elements[key].value = value;
  }
}

async function save(event) {
  event.preventDefault();
  setStatus(saveStatus, "正在保存…", "idle");
  try {
    const settings = readForm();
    await requestEndpointPermission(settings.endpoint);
    await persistSettings(settings);
    setStatus(saveStatus, "设置已保存，刷新 Notebook 页面后生效", "success");
  } catch (error) {
    setStatus(saveStatus, error.message, "error");
  }
}

async function testConnection() {
  testButton.disabled = true;
  setStatus(connectionStatus, "正在连接…", "idle");
  try {
    const settings = readForm();
    await requestEndpointPermission(settings.endpoint);
    await persistSettings(settings);
    const response = await sendMessage({
      type: "DORADUDE_BRIDGE_REQUEST",
      path: "/health",
      method: "GET"
    });
    if (!response.ok) throw new Error(response.error || "连接失败");
    setStatus(connectionStatus, `连接成功 · ${response.data.codex || "Codex"}`, "success");
  } catch (error) {
    setStatus(connectionStatus, error.message, "error");
  } finally {
    testButton.disabled = false;
  }
}

function readForm() {
  const endpoint = new URL(form.elements.endpoint.value.trim());
  if (!/^https?:$/.test(endpoint.protocol)) throw new Error("服务地址仅支持 HTTP 或 HTTPS");
  const customCellSelector = form.elements.customCellSelector.value.trim();
  if (customCellSelector) {
    try {
      document.querySelector(customCellSelector);
    } catch {
      throw new Error("自定义 Cell 选择器不是有效的 CSS 选择器");
    }
  }
  return {
    endpoint: endpoint.origin + endpoint.pathname.replace(/\/$/, ""),
    token: form.elements.token.value.trim(),
    neighborCells: Number(form.elements.neighborCells.value),
    customCellSelector,
    requestTimeoutMs: DEFAULTS.requestTimeoutMs
  };
}

async function requestEndpointPermission(endpoint) {
  const url = new URL(endpoint);
  const originPattern = `${url.protocol}//${url.hostname}/*`;
  const granted = await chrome.permissions.request({ origins: [originPattern] });
  if (!granted) throw new Error("需要服务地址的访问权限才能连接 Codex Bridge");
}

async function persistSettings(settings) {
  const { token, ...synced } = settings;
  await Promise.all([chrome.storage.sync.set(synced), chrome.storage.local.set({ token })]);
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

function setStatus(element, message, kind) {
  element.textContent = message;
  element.dataset.kind = kind;
}
