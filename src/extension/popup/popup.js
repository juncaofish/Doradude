const dot = document.querySelector("#dot");
const label = document.querySelector("#label");
const endpoint = document.querySelector("#endpoint");

document.querySelector("#settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

chrome.storage.sync.get({ endpoint: "http://127.0.0.1:4344" }).then((settings) => {
  endpoint.textContent = settings.endpoint;
  chrome.runtime.sendMessage(
    { type: "DORADUDE_BRIDGE_REQUEST", path: "/health", method: "GET" },
    (response) => {
      if (response?.ok && response.data?.status !== "degraded") {
        dot.className = "ok";
        label.textContent = "Codex Bridge 已连接";
      } else if (response?.ok) {
        dot.className = "error";
        label.textContent = response.data.codexError
          ? `Bridge 已连接，但 Codex 未就绪：${response.data.codexError}`
          : "Bridge 已连接，但 Codex 未就绪";
      } else {
        dot.className = "error";
        label.textContent = response?.error || "Codex Bridge 未连接";
      }
    }
  );
});
