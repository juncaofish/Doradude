(() => {
  const namespace = (globalThis.DoradudeNotebook ||= {});
  const PAGE_REQUEST = "doradude:notebook-request";
  const PAGE_RESPONSE = "doradude:notebook-response";
  const SAFE_NOTEBOOK_QUERY_PARAMS = new Set(["path", "project"]);
  const DEFAULT_CELL_SELECTORS = [
    "[data-doradude-cell]",
    ".jp-CodeCell",
    ".jp-Cell",
    "[data-cell-id]",
    ".notebook-cell"
  ];
  const OUTPUT_SELECTORS = [
    ".jp-OutputArea-output",
    ".jp-OutputArea",
    "[data-output]",
    ".output_area",
    ".cell-output"
  ];

  class NotebookAdapter {
    constructor(options = {}) {
      this.customCellSelector = options.customCellSelector || "";
      this.sequence = 0;
    }

    getCells() {
      const selector = [this.customCellSelector, ...DEFAULT_CELL_SELECTORS]
        .filter(Boolean)
        .join(",");
      const candidates = [...document.querySelectorAll(selector)];
      const outermost = candidates.filter(
        (candidate) => !candidates.some((other) => other !== candidate && other.contains(candidate))
      );
      for (const cell of outermost) this.ensureCellId(cell);
      return outermost;
    }

    findCell(node) {
      if (!(node instanceof Element)) return null;
      return this.getCells().find((cell) => cell === node || cell.contains(node)) || null;
    }

    getActiveCell() {
      const cells = this.getCells();
      const focused = document.activeElement;
      if (focused instanceof Element) {
        const focusedCell = cells.find((cell) => cell === focused || cell.contains(focused));
        if (focusedCell) return focusedCell;
      }
      return (
        cells.find((cell) => cell.classList.contains("jp-mod-active")) ||
        cells.find(
          (cell) =>
            cell.classList.contains("jp-mod-selected") ||
            cell.getAttribute("aria-selected") === "true" ||
            cell.getAttribute("data-active") === "true"
        ) ||
        null
      );
    }

    ensureCellId(cell) {
      if (!cell.dataset.doradudeCellId) {
        this.sequence += 1;
        cell.dataset.doradudeCellId = `cell-${Date.now().toString(36)}-${this.sequence}`;
      }
      return cell.dataset.doradudeCellId;
    }

    getCellPosition(cell) {
      const cells = this.getCells();
      const index = cells.indexOf(cell);
      return { number: index >= 0 ? index + 1 : 0, total: cells.length };
    }

    getSessionKey() {
      return sanitizeNotebookUrl(location.href);
    }

    async getContext(cell, neighborCount = 2) {
      const cells = this.getCells();
      const index = cells.indexOf(cell);
      if (index < 0) throw new Error("当前 Cell 已不存在，请重新选择");
      const start = Math.max(0, index - neighborCount);
      const end = Math.min(cells.length, index + neighborCount + 1);
      const selected = cells.slice(start, end);
      const snapshots = await Promise.all(selected.map((candidate) => this.readCell(candidate)));
      const current = snapshots[index - start];

      return {
        notebook: {
          title: document.title,
          url: this.getSessionKey(),
          totalCells: cells.length
        },
        currentCell: current,
        previousCells: snapshots.slice(0, index - start),
        nextCells: snapshots.slice(index - start + 1)
      };
    }

    async readCell(cell) {
      const id = this.ensureCellId(cell);
      let editor;
      try {
        editor = await requestPage({ operation: "read", cellId: id });
      } catch {
        editor = readDomFallback(cell);
      }

      return {
        id,
        source: editor.source,
        selection: editor.selection || selectionInside(cell),
        language: editor.language || inferLanguage(cell),
        output: readOutput(cell)
      };
    }

    async replaceCell(cell, code) {
      const id = this.ensureCellId(cell);
      try {
        const result = await requestPage({ operation: "replace", cellId: id, code });
        if (!result?.applied || result.source !== code) throw new Error("Notebook editor did not confirm the replacement");
      } catch (primaryError) {
        if (!writeDomFallback(cell, code)) throw primaryError;
      }
    }

    async insertCellBelow(cell, code) {
      const beforeCells = this.getCells();
      const targetIndex = beforeCells.indexOf(cell);
      if (targetIndex < 0) throw new Error("当前 Cell 已不存在，请重新选择");
      const before = new Set(beforeCells);
      const originalNext = beforeCells[targetIndex + 1] || null;
      const button = findInsertButton(cell);
      if (button) {
        button.click();
      } else {
        cell.scrollIntoView({ block: "center", behavior: "instant" });
        cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        cell.click();
        document.activeElement?.blur?.();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "b", code: "KeyB", bubbles: true }));
      }

      const inserted = await waitFor(
        () => findInsertedCellBelow(this.getCells(), cell, before, originalNext),
        2500
      );
      if (!inserted) {
        throw new Error("未能插入 Cell。DataLeap 页面结构可能已变化，请在设置中配置 Cell 选择器");
      }
      await this.replaceCell(inserted, code);
      inserted.scrollIntoView({ block: "center", behavior: "smooth" });
      return inserted;
    }
  }

  function requestPage(detail, timeoutMs = 1500) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        window.removeEventListener(PAGE_RESPONSE, onResponse);
        reject(new Error("Notebook editor bridge did not respond"));
      }, timeoutMs);

      function onResponse(event) {
        if (event.detail?.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener(PAGE_RESPONSE, onResponse);
        if (event.detail.ok) resolve(event.detail.result);
        else reject(new Error(event.detail.error || "Notebook editor operation failed"));
      }

      window.addEventListener(PAGE_RESPONSE, onResponse);
      window.dispatchEvent(new CustomEvent(PAGE_REQUEST, { detail: { id, ...detail } }));
    });
  }

  function readDomFallback(cell) {
    const monaco = cell.querySelector(".monaco-editor");
    if (monaco) {
      return { source: readRenderedLines(cell), selection: selectionInside(cell), language: "" };
    }
    const input = cell.querySelector("textarea");
    if (input) {
      return {
        source: input.value,
        selection: input.value.slice(input.selectionStart, input.selectionEnd),
        language: ""
      };
    }
    const source = cell.getAttribute("data-source") || readRenderedLines(cell);
    return { source, selection: selectionInside(cell), language: "" };
  }

  function writeDomFallback(cell, code) {
    const input = cell.querySelector("textarea");
    if (!input || input.closest(".monaco-editor")) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(input, code);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: code }));
    return true;
  }

  function readRenderedLines(cell) {
    const lines = [...cell.querySelectorAll(".view-line, .cm-line")];
    if (lines.length) return lines.map((line) => line.textContent || "").join("\n");
    const code = cell.querySelector("pre, code, .input_area");
    return code?.textContent || "";
  }

  function readOutput(cell) {
    for (const selector of OUTPUT_SELECTORS) {
      const outputs = [...cell.querySelectorAll(selector)];
      const text = outputs.map((node) => node.innerText || node.textContent || "").join("\n").trim();
      if (text) return text.slice(-12000);
    }
    return "";
  }

  function selectionInside(cell) {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.anchorNode) return "";
    return cell.contains(selection.anchorNode) ? selection.toString() : "";
  }

  function inferLanguage(cell) {
    return (
      cell.getAttribute("data-language") ||
      document.querySelector("[data-kernel-language]")?.getAttribute("data-kernel-language") ||
      "python"
    );
  }

  function findInsertButton(cell) {
    const selectors = [
      '[data-command="notebook:insert-cell-below"]',
      '[title="New Cell" i]',
      ".icon-add_circle",
      'button[aria-label*="below" i]',
      'button[title*="below" i]',
      'button[aria-label*="下方" i]',
      'button[title*="下方" i]',
      ".jp-CellFooter button",
      ".jp-Cell-insertButton"
    ];
    const local = cell.querySelector(selectors.join(","));
    if (local) return local;
    let sibling = cell.nextElementSibling;
    for (let attempt = 0; sibling && attempt < 2; attempt += 1, sibling = sibling.nextElementSibling) {
      const nearby = sibling.matches?.("button") ? sibling : sibling.querySelector?.("button");
      if (nearby && /insert|add|新增|添加/i.test(nearby.getAttribute("aria-label") || nearby.title || nearby.textContent || "")) {
        return nearby;
      }
    }
    return null;
  }

  function findInsertedCellBelow(cells, target, before, originalNext) {
    const targetIndex = cells.indexOf(target);
    if (targetIndex < 0) return null;
    const candidate = cells[targetIndex + 1];
    if (!candidate || before.has(candidate)) return null;

    if (originalNext) return cells[targetIndex + 2] === originalNext ? candidate : null;
    const focused = document.activeElement;
    const active =
      candidate.classList.contains("jp-mod-active") ||
      candidate.classList.contains("jp-mod-selected") ||
      candidate.getAttribute("aria-selected") === "true" ||
      candidate.getAttribute("data-active") === "true" ||
      (focused instanceof Element && candidate.contains(focused));
    return active ? candidate : null;
  }

  function waitFor(check, timeoutMs) {
    return new Promise((resolve) => {
      const found = check();
      if (found) return resolve(found);
      const observer = new MutationObserver(() => {
        const value = check();
        if (!value) return;
        observer.disconnect();
        clearTimeout(timer);
        resolve(value);
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "aria-selected", "data-active"]
      });
      const timer = setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeoutMs);
    });
  }

  function sanitizeNotebookUrl(value) {
    const url = new URL(value, location.href);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (!SAFE_NOTEBOOK_QUERY_PARAMS.has(key)) url.searchParams.delete(key);
    }
    return url.href;
  }

  namespace.NotebookAdapter = NotebookAdapter;
  namespace.sanitizeNotebookUrl = sanitizeNotebookUrl;
})();
