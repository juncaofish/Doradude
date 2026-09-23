(() => {
  if (globalThis.__DORADUDE_NOTEBOOK_CONTENT__) return;
  globalThis.__DORADUDE_NOTEBOOK_CONTENT__ = true;

  const isTopFrame = window === window.top;
  let settings = { neighborCells: 2, customCellSelector: "", theme: "light" };
  let adapter;
  let ui;
  const streamRequests = new Map();

  chrome.runtime.sendMessage({ type: "DORADUDE_GET_SETTINGS" }, (stored) => {
    if (chrome.runtime.lastError) return;
    settings = { ...settings, ...stored };
    adapter = new DoradudeNotebook.NotebookAdapter(settings);
    if (isTopFrame) startTopFrame();
    else startNotebookFrame();
  });

  function startTopFrame() {
    ui = new DoradudeNotebook.DoradudeUI({
      onSubmit: submitToCodex,
      onApply: applyResult,
      onResetSession: resetSession,
      onOpenSettings: () => chrome.runtime.sendMessage({ type: "DORADUDE_OPEN_OPTIONS" }),
      onThemeChange: persistTheme,
      onPanelToggle: updateDockedLayout,
      initialTheme: settings.theme,
      iconUrl: chrome.runtime.getURL?.("icons/icon48.png") || ""
    });
    observeLocalNotebook();
    chrome.runtime.onMessage.addListener(handlePortalEvent);
    chrome.runtime.onMessage.addListener(handleBridgeStreamEvent);
  }

  async function persistTheme(theme) {
    settings.theme = theme;
    await sendRuntimeMessage({ type: "DORADUDE_SET_THEME", theme });
  }

  const dockedLayout = { frame: null, frameStyles: null };

  function updateDockedLayout(open, panelWidth) {
    restoreDockedFrame();
    resetPanelBounds();
    if (!open || !ui?.activeCell?.portal) return;

    const frame = findNotebookFrame(ui.activeCell.frameKey);
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    if (rect.width < 720 || rect.height < 320) return;

    const width = Math.min(Math.ceil(panelWidth || 440), Math.max(320, Math.floor(rect.width * 0.42)));
    dockedLayout.frame = frame;
    dockedLayout.frameStyles = snapshotStyles(frame, ["width", "max-width", "flex-basis"]);
    frame.style.setProperty("width", `${Math.max(400, Math.floor(rect.width - width))}px`, "important");
    frame.style.setProperty("max-width", `calc(100% - ${width}px)`, "important");
    frame.style.setProperty("flex-basis", `calc(100% - ${width}px)`, "important");

    ui.panel.style.setProperty("top", `${Math.max(0, rect.top)}px`, "important");
    ui.panel.style.setProperty("right", `${Math.max(0, window.innerWidth - rect.right)}px`, "important");
    ui.panel.style.setProperty("bottom", "auto", "important");
    ui.panel.style.setProperty("width", `${width}px`, "important");
    ui.panel.style.setProperty("height", `${Math.min(rect.height, window.innerHeight - Math.max(0, rect.top))}px`, "important");
    ui.panel.dataset.docked = "true";
  }

  window.addEventListener("resize", () => {
    if (ui?.panel?.dataset.open === "true") updateDockedLayout(true, ui.panel.getBoundingClientRect().width);
  });

  function restoreDockedFrame() {
    if (!dockedLayout.frame || !dockedLayout.frameStyles) return;
    restoreStyles(dockedLayout.frame, dockedLayout.frameStyles);
    dockedLayout.frame = null;
    dockedLayout.frameStyles = null;
  }

  function resetPanelBounds() {
    if (!ui?.panel) return;
    for (const property of ["top", "right", "bottom", "width", "height"]) ui.panel.style.removeProperty(property);
    delete ui.panel.dataset.docked;
  }

  function snapshotStyles(element, properties) {
    return properties.map((property) => ({
      property,
      value: element.style.getPropertyValue(property),
      priority: element.style.getPropertyPriority(property)
    }));
  }

  function restoreStyles(element, styles) {
    for (const { property, value, priority } of styles) {
      if (value) element.style.setProperty(property, value, priority);
      else element.style.removeProperty(property);
    }
  }

  function startNotebookFrame() {
    observeNotebookFrame();
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== "DORADUDE_FRAME_COMMAND") return false;
      handleFrameCommand(message)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    });
    chrome.runtime.onMessage.addListener(handleBridgeStreamEvent);
  }

  function observeLocalNotebook() {
    let hoveredCell = null;
    ui.selectCell(withCellLabel(adapter.getActiveCell()));
    const selectFromEvent = (event) => {
      const cell = adapter.findCell(event.target);
      if (cell) ui.selectCell(withCellLabel(cell));
    };
    document.addEventListener("pointerdown", selectFromEvent, true);
    document.addEventListener("focusin", selectFromEvent, true);
    document.addEventListener("keydown", scheduleActiveCellSync, true);
    document.addEventListener(
      "pointerover",
      (event) => {
        if (ui.host.contains(event.target)) return;
        const cell = adapter.findCell(event.target);
        if (!cell || cell === hoveredCell) return;
        hoveredCell = cell;
        ui.showToolbar(withCellLabel(cell));
      },
      true
    );
    document.addEventListener(
      "pointerout",
      (event) => {
        if (!hoveredCell || hoveredCell.contains(event.relatedTarget)) return;
        hoveredCell = null;
        ui.scheduleHide();
      },
      true
    );

    function scheduleActiveCellSync(event) {
      if (!["ArrowUp", "ArrowDown", "Enter", "Escape"].includes(event.key)) return;
      setTimeout(() => ui.selectCell(withCellLabel(adapter.getActiveCell())), 0);
    }
  }

  function withCellLabel(cell) {
    if (!cell) return null;
    const position = adapter.getCellPosition(cell);
    cell.doradudeLabel = formatCellLabel(position.number, position.total);
    return cell;
  }

  function formatCellLabel(number, total) {
    return number > 0 ? `Cell ${number} / ${total}` : "已选择当前 Cell";
  }

  function observeNotebookFrame() {
    let hoveredCell = null;
    let selectedCellId = "";
    const selectFromEvent = (event) => {
      const cell = adapter.findCell(event.target);
      if (cell) notifySelectedCell(cell);
    };
    document.addEventListener("pointerdown", selectFromEvent, true);
    document.addEventListener("focusin", selectFromEvent, true);
    document.addEventListener(
      "keydown",
      (event) => {
        if (!["ArrowUp", "ArrowDown", "Enter", "Escape"].includes(event.key)) return;
        setTimeout(() => notifySelectedCell(adapter.getActiveCell()), 0);
      },
      true
    );
    notifySelectedCell(adapter.getActiveCell());
    document.addEventListener(
      "pointerover",
      (event) => {
        const cell = adapter.findCell(event.target);
        if (!cell || cell === hoveredCell) return;
        hoveredCell = cell;
        const rect = cell.getBoundingClientRect();
        const position = adapter.getCellPosition(cell);
        chrome.runtime.sendMessage({
          type: "DORADUDE_FRAME_EVENT",
          event: "show",
          frameKey: adapter.getSessionKey(),
          cellId: adapter.ensureCellId(cell),
          cellNumber: position.number,
          totalCells: position.total,
          rect: { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left }
        });
      },
      true
    );
    document.addEventListener(
      "pointerout",
      (event) => {
        if (!hoveredCell || hoveredCell.contains(event.relatedTarget)) return;
        const cellId = adapter.ensureCellId(hoveredCell);
        hoveredCell = null;
        chrome.runtime.sendMessage({
          type: "DORADUDE_FRAME_EVENT",
          event: "hide",
          frameKey: adapter.getSessionKey(),
          cellId
        });
      },
      true
    );

    function notifySelectedCell(cell) {
      if (!cell) return;
      const cellId = adapter.ensureCellId(cell);
      const position = adapter.getCellPosition(cell);
      const selectionKey = `${cellId}:${position.number}:${position.total}`;
      if (selectionKey === selectedCellId) return;
      selectedCellId = selectionKey;
      const rect = cell.getBoundingClientRect();
      chrome.runtime.sendMessage({
        type: "DORADUDE_FRAME_EVENT",
        event: "select",
        frameKey: adapter.getSessionKey(),
        cellId,
        cellNumber: position.number,
        totalCells: position.total,
        rect: { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left }
      });
    }
  }

  function handlePortalEvent(message) {
    if (message?.type !== "DORADUDE_PORTAL_EVENT") return false;
    if (message.event === "progress") {
      const targetCell = ui.activeExchange?.cell || ui.activeCell;
      if (
        targetCell?.portal &&
        targetCell.frameId === message.frameId &&
        targetCell.cellId === message.cellId
      ) {
        ui.updateProgress(message.message);
      }
      return false;
    }
    if (message.event === "stream") {
      const targetCell = ui.activeExchange?.cell || ui.activeCell;
      if (
        targetCell?.portal &&
        targetCell.frameId === message.frameId &&
        targetCell.cellId === message.cellId
      ) {
        ui.handleStreamEvent(message.stream);
      }
      return false;
    }
    if (message.event === "hide") {
      if (
        ui.activeCell?.portal &&
        ui.activeCell.frameId === message.frameId &&
        ui.activeCell.cellId === message.cellId
      ) {
        ui.scheduleHide();
      }
      return false;
    }
    if (!["show", "select"].includes(message.event) || !message.rect) return false;
    const iframe = findNotebookFrame(message.frameKey);
    if (!iframe) return false;
    const frameRect = iframe.getBoundingClientRect();
    const rect = {
      top: frameRect.top + message.rect.top,
      right: frameRect.left + message.rect.right,
      bottom: frameRect.top + message.rect.bottom,
      left: frameRect.left + message.rect.left
    };
    const portalCell = {
      portal: true,
      frameId: message.frameId,
      frameKey: message.frameKey,
      cellId: message.cellId,
      label: formatCellLabel(message.cellNumber, message.totalCells),
      getBoundingClientRect: () => rect
    };
    if (message.event === "select") {
      ui.selectCell(portalCell);
      if (ui.panel.dataset.open === "true") updateDockedLayout(true, ui.panel.getBoundingClientRect().width);
    }
    else ui.showToolbar(portalCell);
    return false;
  }

  function findNotebookFrame(frameKey) {
    const frames = [...document.querySelectorAll('iframe[data-notebook-dom="true"], iframe[id^="notebook-iframe-"]')];
    const exact = frames.find((frame) => {
      try {
        return DoradudeNotebook.sanitizeNotebookUrl(frame.src) === frameKey;
      } catch {
        return false;
      }
    });
    if (exact) return exact;

    try {
      const notebookPath = new URL(frameKey).searchParams.get("path");
      if (notebookPath) {
        const sameNotebook = frames.find((frame) => new URL(frame.src).searchParams.get("path") === notebookPath);
        if (sameNotebook) return sameNotebook;
      }
    } catch {}

    const visible = frames.filter((frame) => {
      const rect = frame.getBoundingClientRect();
      const style = getComputedStyle(frame);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
    return visible.length === 1 ? visible[0] : null;
  }

  async function submitToCodex({ cell, action, instruction }) {
    if (cell.portal) return sendPortalCommand(cell, "submit", { action, instruction });
    reportProgress(cell, "正在读取当前 Cell 与相邻上下文");
    const context = await adapter.getContext(cell, Number(settings.neighborCells) || 2);
    reportProgress(cell, "上下文已收集，正在发送给 Codex");
    const pending = requestBridgeStream("/v1/codex/stream", { action, instruction, context }, cell);
    reportProgress(cell, "请求已发送，正在等待 Codex");
    return pending;
  }

  function handleBridgeStreamEvent(message) {
    if (message?.type !== "DORADUDE_BRIDGE_STREAM_EVENT") return false;
    const cell = streamRequests.get(message.requestId);
    if (!cell) return false;
    if (isTopFrame) ui?.handleStreamEvent(message.event);
    else {
      chrome.runtime.sendMessage({
        type: "DORADUDE_FRAME_EVENT",
        event: "stream",
        frameKey: adapter.getSessionKey(),
        cellId: adapter.ensureCellId(cell),
        stream: message.event
      });
    }
    return false;
  }

  function reportProgress(cell, message) {
    if (isTopFrame) {
      ui?.updateProgress(message);
      return;
    }
    chrome.runtime.sendMessage({
      type: "DORADUDE_FRAME_EVENT",
      event: "progress",
      frameKey: adapter.getSessionKey(),
      cellId: adapter.ensureCellId(cell),
      message
    });
  }

  async function applyResult({ cell, result }) {
    if (cell.portal) return sendPortalCommand(cell, "apply", { result });
    if (typeof result.code !== "string") throw new Error("Codex 没有返回可应用的代码");
    if (result.mode === "replace") return adapter.replaceCell(cell, result.code);
    if (result.mode === "insert") return adapter.insertCellBelow(cell, result.code);
    throw new Error("这个建议不包含 Notebook 修改");
  }

  async function resetSession(cell) {
    if (cell?.portal) return sendPortalCommand(cell, "reset", {});
    return requestBridge("/v1/session/reset", { sessionKey: adapter.getSessionKey() });
  }

  async function handleFrameCommand(message) {
    const cell = message.cellId
      ? adapter.getCells().find((candidate) => adapter.ensureCellId(candidate) === message.cellId)
      : null;
    if (message.command === "submit") {
      if (!cell) throw new Error("当前 Cell 已不存在，请重新选择");
      return submitToCodex({ cell, ...message.payload });
    }
    if (message.command === "apply") {
      if (!cell) throw new Error("当前 Cell 已不存在，请重新选择");
      await applyResult({ cell, result: message.payload.result });
      return { applied: true };
    }
    if (message.command === "reset") return resetSession(null);
    throw new Error("Unsupported frame command");
  }

  async function sendPortalCommand(cell, command, payload) {
    const response = await sendRuntimeMessage({
      type: "DORADUDE_PORTAL_COMMAND",
      targetFrameId: cell.frameId,
      cellId: cell.cellId,
      command,
      payload
    });
    if (!response?.ok) throw new Error(response?.error || "Notebook iframe 请求失败");
    return response.data;
  }

  async function requestBridge(path, body) {
    const response = await sendRuntimeMessage({
      type: "DORADUDE_BRIDGE_REQUEST",
      path,
      method: "POST",
      body
    });
    if (!response?.ok) throw new Error(response?.error || "Codex Bridge 请求失败");
    return response.data;
  }

  async function requestBridgeStream(path, body, cell) {
    const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    streamRequests.set(requestId, cell);
    try {
      const response = await sendRuntimeMessage({
        type: "DORADUDE_BRIDGE_STREAM",
        requestId,
        path,
        method: "POST",
        body
      });
      if (!response?.ok) throw new Error(response?.error || "Codex Bridge 请求失败");
      return response.data;
    } finally {
      streamRequests.delete(requestId);
    }
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    });
  }
})();
