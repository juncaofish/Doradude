const dot = document.querySelector("#dot");
const label = document.querySelector("#label");
const endpoint = document.querySelector("#endpoint");

document.querySelector("#settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

chrome.storage.sync.get({ endpoint: "http://127.0.0.1:4344" }).then((settings) => {
  endpoint.textContent = settings.endpoint;
  chrome.runtime.sendMessage(
    { type: "DORADUDE_BRIDGE_REQUEST", path: "/health", method: "GET" },
    (response) => {
      if (response?.ok) {
        dot.className = "ok";
        label.textContent = "Codex Bridge 已连接";
      } else {
        dot.className = "error";
        label.textContent = response?.error || "Codex Bridge 未连接";
      }
    }
  );
});
