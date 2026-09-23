(() => {
  const namespace = (globalThis.DoradudeNotebook ||= {});
  const ACTION_LABELS = { edit: "编辑", fix: "修复", explain: "解释", optimize: "优化" };

  class DoradudeUI {
    constructor({ onSubmit, onApply, onResetSession, onOpenSettings, onThemeChange, onPanelToggle, initialTheme = "light", iconUrl = "" }) {
      this.handlers = { onSubmit, onApply, onResetSession, onOpenSettings, onThemeChange, onPanelToggle };
      this.theme = initialTheme === "dark" ? "dark" : "light";
      this.iconUrl = iconUrl;
      this.activeCell = null;
      this.hoveredCell = null;
      this.activeExchange = null;
      this.resultEntries = new Map();
      this.nextMessageId = 1;
      this.mount();
    }

    mount() {
      this.host = document.createElement("div");
      this.host.id = "doradude-notebook-root";
      const supportsTopLayer = typeof this.host.showPopover === "function";
      if (supportsTopLayer) this.host.setAttribute("popover", "manual");
      this.host.dataset.layer = supportsTopLayer ? "top" : "fixed";
      this.host.style.cssText =
        "all:initial;display:block;position:fixed;inset:0;width:auto;height:auto;margin:0;border:0;padding:0;background:transparent;overflow:visible;pointer-events:none";
      this.host.style.setProperty("z-index", "2147483647", "important");
      document.documentElement.append(this.host);
      this.shadow = this.host.attachShadow({ mode: "open" });
      this.shadow.innerHTML = `${styles()}${markup()}`;
      if (supportsTopLayer) this.host.showPopover();

      this.toolbar = this.shadow.querySelector(".mn-toolbar");
      this.panel = this.shadow.querySelector(".mn-panel");
      this.chat = this.shadow.querySelector(".mn-chat");
      this.empty = this.shadow.querySelector(".mn-empty");
      this.prompt = this.shadow.querySelector("textarea");
      this.submit = this.shadow.querySelector(".mn-submit");
      this.contextLabel = this.shadow.querySelector(".mn-context-label");
      this.brandIcon = this.shadow.querySelector(".mn-brand-icon");
      if (this.iconUrl) this.brandIcon.src = this.iconUrl;
      else this.brandIcon.hidden = true;
      this.themeToggle = this.shadow.querySelector(".mn-theme");
      this.setTheme(this.theme);

      this.toolbar.addEventListener("mouseenter", () => clearTimeout(this.hideTimer));
      this.toolbar.addEventListener("mouseleave", () => this.scheduleHide());
      this.shadow.querySelector(".mn-ask").addEventListener("click", () => this.open("edit"));
      this.shadow.querySelector(".mn-fix").addEventListener("click", () => this.open("fix"));
      this.shadow.querySelector(".mn-close").addEventListener("click", () => this.close());
      this.shadow.querySelector(".mn-reset").addEventListener("click", () => this.resetSession());
      this.themeToggle.addEventListener("click", () => this.setTheme(this.theme === "dark" ? "light" : "dark", true));
      this.shadow.querySelector(".mn-settings").addEventListener("click", this.handlers.onOpenSettings);
      this.shadow.querySelector(".mn-actions").addEventListener("click", (event) => this.selectAction(event));
      this.submit.addEventListener("click", () => this.submitRequest());
      this.chat.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-result-id]");
        if (button) this.applyResult(button.dataset.resultId, button);
      });
      this.prompt.addEventListener("keydown", (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") this.submitRequest();
      });
    }

    setTheme(theme, persist = false) {
      this.theme = theme === "dark" ? "dark" : "light";
      this.panel.dataset.theme = this.theme;
      const dark = this.theme === "dark";
      this.themeToggle.textContent = dark ? "☀" : "☾";
      this.themeToggle.title = dark ? "切换到浅色" : "切换到深色";
      this.themeToggle.setAttribute("aria-label", this.themeToggle.title);
      if (persist) Promise.resolve(this.handlers.onThemeChange?.(this.theme)).catch(() => {});
    }

    showToolbar(cell) {
      this.hoveredCell = cell;
      if (this.panel.dataset.open === "true") return;
      const rect = cell.getBoundingClientRect();
      const top = Math.max(8, Math.min(window.innerHeight - 42, rect.top + 8));
      const left = Math.max(8, Math.min(window.innerWidth - 190, rect.left + 8));
      this.toolbar.style.transform = `translate(${left}px, ${top}px)`;
      this.toolbar.dataset.visible = "true";
    }

    scheduleHide() {
      clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => {
        if (this.panel.dataset.open !== "true") this.toolbar.dataset.visible = "false";
      }, 180);
    }

    open(action = "edit") {
      if (this.hoveredCell) this.selectCell(this.hoveredCell);
      if (!this.activeCell) return;
      this.selectActionByName(action);
      this.panel.dataset.open = "true";
      this.toolbar.dataset.visible = "false";
      this.handlers.onPanelToggle?.(true, this.panel.getBoundingClientRect().width);
      setTimeout(() => this.prompt.focus(), 0);
    }

    selectCell(cell) {
      if (!cell || this.submit.disabled) return;
      this.activeCell = cell;
      this.contextLabel.textContent = cell.label || cell.doradudeLabel || "已选择当前 Cell";
    }

    close() {
      this.panel.dataset.open = "false";
      this.handlers.onPanelToggle?.(false, 0);
    }

    selectAction(event) {
      const button = event.target.closest("button[data-action]");
      if (button) this.selectActionByName(button.dataset.action);
    }

    selectActionByName(action) {
      for (const button of this.shadow.querySelectorAll("[data-action]")) {
        button.dataset.selected = String(button.dataset.action === action);
      }
      this.action = action;
      const defaults = {
        edit: "描述你希望如何修改当前 Cell",
        fix: "修复当前 Cell，并结合最近的输出或报错",
        explain: "解释当前 Cell 的逻辑、输入与输出",
        optimize: "优化当前 Cell 的可读性和执行效率"
      };
      this.prompt.placeholder = defaults[action];
    }

    async submitRequest() {
      if (!this.activeCell || this.submit.disabled) return;
      const cell = this.activeCell;
      const action = this.action || "edit";
      const instruction = this.prompt.value.trim() || this.prompt.placeholder;
      const exchange = this.beginExchange(instruction, action, cell);
      this.prompt.value = "";
      this.setLoading(true);
      try {
        const response = await this.handlers.onSubmit({ cell, action, instruction });
        this.completeExchange(exchange, response);
      } catch (error) {
        this.failExchange(exchange, error.message || "请求失败");
      } finally {
        this.setLoading(false);
      }
    }

    beginExchange(instruction, action, cell) {
      this.empty.hidden = true;
      const id = String(this.nextMessageId++);
      const user = document.createElement("article");
      user.className = "mn-message mn-user-message";
      const userMeta = document.createElement("span");
      userMeta.className = "mn-message-meta";
      userMeta.textContent = ACTION_LABELS[action] || "请求";
      const userText = document.createElement("p");
      userText.textContent = instruction;
      user.append(userMeta, userText);

      const assistant = document.createElement("article");
      assistant.className = "mn-message mn-assistant-message";
      const details = document.createElement("details");
      details.className = "mn-reasoning";
      details.open = true;
      const reasoningSummary = document.createElement("summary");
      const reasoningTitle = document.createElement("span");
      reasoningTitle.className = "mn-reasoning-title";
      reasoningTitle.textContent = "正在准备上下文";
      const reasoningTime = document.createElement("span");
      reasoningTime.className = "mn-reasoning-time";
      reasoningTime.textContent = "0 秒";
      reasoningSummary.append(reasoningTitle, reasoningTime);
      const reasoning = document.createElement("div");
      reasoning.className = "mn-reasoning-content";
      reasoning.textContent = "";
      details.append(reasoningSummary, reasoning);
      const answer = document.createElement("div");
      answer.className = "mn-answer";
      answer.hidden = true;
      assistant.append(details, answer);
      this.chat.append(user, assistant);

      const exchange = {
        id,
        cell,
        details,
        reasoning,
        reasoningTitle,
        reasoningTime,
        answer,
        startedAt: performance.now(),
        hasReasoning: false,
        lastProcessMessage: "",
        lastPlan: "",
        reasoningMarkdown: "",
        reasoningBody: null
      };
      this.appendProcessLine(exchange, "正在读取当前 Cell 与相邻上下文");
      exchange.timer = setInterval(() => this.renderElapsed(exchange), 500);
      this.activeExchange = exchange;
      this.scrollChat();
      return exchange;
    }

    handleStreamEvent(event) {
      const exchange = this.activeExchange;
      if (!exchange || !event) return;
      if (event.type === "phase") {
        exchange.reasoningTitle.textContent = event.message || "Codex 正在处理";
        this.appendProcessLine(exchange, event.message);
      } else if (event.type === "task") {
        exchange.reasoningTitle.textContent = event.message || "Codex 正在处理";
        this.appendProcessLine(exchange, event.message);
      } else if (event.type === "plan") {
        const plan = JSON.stringify(event.plan || []);
        if (plan !== exchange.lastPlan) {
          exchange.lastPlan = plan;
          for (const item of event.plan || []) {
            const status =
              { pending: "待处理", inProgress: "进行中", in_progress: "进行中", completed: "已完成" }[item.status] ||
              item.status;
            this.appendProcessLine(exchange, `${status ? `[${status}] ` : ""}${item.step || "任务步骤"}`);
          }
        }
      } else if (event.type === "reasoning_section") {
        if (exchange.hasReasoning && !exchange.reasoningMarkdown.endsWith("\n\n")) {
          exchange.reasoningMarkdown += "\n\n";
        }
      } else if (event.type === "reasoning_delta" && event.delta) {
        if (!exchange.hasReasoning) {
          exchange.hasReasoning = true;
          this.appendProcessLine(exchange, "模型分析摘要");
          exchange.reasoningBody = document.createElement("div");
          exchange.reasoningBody.className = "mn-process-reasoning mn-markdown";
          exchange.reasoning.append(exchange.reasoningBody);
        }
        exchange.reasoningTitle.textContent = "Codex 正在分析";
        exchange.reasoningMarkdown += event.delta;
        const rendered = renderMarkdown(exchange.reasoningMarkdown);
        exchange.reasoningBody.replaceChildren(...rendered.childNodes);
      }
      this.scrollChat();
    }

    appendProcessLine(exchange, message) {
      const text = String(message || "").trim();
      if (!text || text === exchange.lastProcessMessage) return;
      exchange.lastProcessMessage = text;
      const seconds = Math.floor((performance.now() - exchange.startedAt) / 1000);
      const line = document.createElement("div");
      line.className = "mn-process-line";
      const time = document.createElement("span");
      time.className = "mn-process-time";
      time.textContent = `${seconds} 秒`;
      const renderedMessage = renderMarkdown(text);
      renderedMessage.classList.add("mn-process-message");
      line.append(time, renderedMessage);
      exchange.reasoning.append(line);
    }

    completeExchange(exchange, response) {
      this.finishReasoning(exchange, "查看分析过程");
      const explanation = response.explanation || response.summary || "Codex 未返回说明";
      const summary = renderMarkdown(response.summary || explanation);
      summary.classList.add("mn-summary");
      exchange.answer.append(summary);

      if (typeof response.code === "string" && response.code) {
        const code = document.createElement("pre");
        code.className = "mn-code";
        code.textContent = response.code;
        exchange.answer.append(code);
      }
      if (response.explanation && response.explanation !== response.summary) {
        const detail = renderMarkdown(response.explanation);
        detail.classList.add("mn-explanation");
        exchange.answer.append(detail);
      }

      const canApply = (response.mode === "replace" || response.mode === "insert") && response.code;
      if (canApply) {
        const actions = document.createElement("div");
        actions.className = "mn-result-actions";
        const apply = document.createElement("button");
        apply.className = "mn-apply primary";
        apply.type = "button";
        apply.dataset.resultId = exchange.id;
        apply.textContent = response.mode === "insert" ? "插入到下方" : "应用到当前 Cell";
        actions.append(apply);
        exchange.answer.append(actions);
        this.resultEntries.set(exchange.id, { cell: exchange.cell, result: response });
      }
      exchange.answer.hidden = false;
      this.activeExchange = null;
      this.scrollChat();
    }

    failExchange(exchange, message) {
      this.finishReasoning(exchange, "处理未完成", true);
      const error = document.createElement("p");
      error.className = "mn-error";
      error.textContent = message;
      exchange.answer.append(error);
      exchange.answer.hidden = false;
      this.activeExchange = null;
      this.scrollChat();
    }

    finishReasoning(exchange, title, keepOpen = false) {
      clearInterval(exchange.timer);
      this.renderElapsed(exchange);
      exchange.reasoningTitle.textContent = title;
      exchange.details.open = keepOpen;
    }

    renderElapsed(exchange) {
      const seconds = Math.floor((performance.now() - exchange.startedAt) / 1000);
      exchange.reasoningTime.textContent = `${seconds} 秒`;
    }

    async applyResult(resultId, button) {
      const entry = this.resultEntries.get(resultId);
      if (!entry || button.disabled) return;
      button.disabled = true;
      button.textContent = "正在写入…";
      try {
        await this.handlers.onApply(entry);
        button.textContent = "已应用";
        this.resultEntries.delete(resultId);
      } catch (error) {
        button.disabled = false;
        button.textContent = error.message || "写入失败";
      }
    }

    async resetSession() {
      if (this.submit.disabled) return;
      if (!confirm("清除当前对话并新建 Codex 会话？")) return;
      try {
        await this.handlers.onResetSession(this.activeCell);
        for (const message of this.chat.querySelectorAll(".mn-message")) message.remove();
        this.resultEntries.clear();
        this.activeExchange = null;
        this.empty.hidden = false;
      } catch (error) {
        const exchange = this.beginExchange("新建对话", "edit", this.activeCell);
        this.failExchange(exchange, error.message || "重置会话失败");
      }
    }

    setLoading(loading) {
      this.submit.disabled = loading;
      this.submit.textContent = loading ? "Codex 正在处理…" : "发送";
    }

    scrollChat() {
      requestAnimationFrame(() => {
        this.chat.scrollTop = this.chat.scrollHeight;
      });
    }

    updateProgress(message) {
      this.handleStreamEvent({ type: "phase", message });
    }
  }

  function renderMarkdown(value) {
    const container = document.createElement("div");
    container.className = "mn-markdown";
    const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
    let index = 0;

    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        index += 1;
        continue;
      }

      const fence = line.match(/^\s*```([\w+-]*)\s*$/);
      if (fence) {
        const chunks = [];
        index += 1;
        while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) chunks.push(lines[index++]);
        if (index < lines.length) index += 1;
        const pre = document.createElement("pre");
        pre.className = "mn-markdown-code";
        const code = document.createElement("code");
        if (fence[1]) code.className = `language-${fence[1].replace(/[^\w+-]/g, "")}`;
        code.textContent = chunks.join("\n");
        pre.append(code);
        container.append(pre);
        continue;
      }

      const heading = line.match(/^\s*(#{1,4})\s+(.+)$/);
      if (heading) {
        const node = document.createElement(`h${Math.min(heading[1].length + 2, 6)}`);
        appendInlineMarkdown(node, heading[2]);
        container.append(node);
        index += 1;
        continue;
      }

      if (isTableHeader(lines, index)) {
        const table = document.createElement("table");
        const head = document.createElement("thead");
        const headRow = document.createElement("tr");
        for (const cell of splitTableRow(lines[index])) {
          const th = document.createElement("th");
          appendInlineMarkdown(th, cell);
          headRow.append(th);
        }
        head.append(headRow);
        table.append(head);
        index += 2;
        const body = document.createElement("tbody");
        while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
          const row = document.createElement("tr");
          for (const cell of splitTableRow(lines[index])) {
            const td = document.createElement("td");
            appendInlineMarkdown(td, cell);
            row.append(td);
          }
          body.append(row);
          index += 1;
        }
        table.append(body);
        container.append(table);
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        const quote = document.createElement("blockquote");
        const chunks = [];
        while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
          chunks.push(lines[index++].replace(/^\s*>\s?/, ""));
        }
        appendInlineMarkdown(quote, chunks.join("\n"));
        container.append(quote);
        continue;
      }

      const listMatch = line.match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/);
      if (listMatch) {
        const ordered = Boolean(listMatch[2]);
        const list = document.createElement(ordered ? "ol" : "ul");
        while (index < lines.length) {
          const item = lines[index].match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/);
          if (!item || Boolean(item[2]) !== ordered) break;
          const li = document.createElement("li");
          appendInlineMarkdown(li, item[3]);
          list.append(li);
          index += 1;
        }
        container.append(list);
        continue;
      }

      if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
        container.append(document.createElement("hr"));
        index += 1;
        continue;
      }

      const paragraph = [];
      while (index < lines.length && lines[index].trim() && !startsMarkdownBlock(lines, index)) {
        paragraph.push(lines[index++].trim());
      }
      if (!paragraph.length) paragraph.push(lines[index++].trim());
      const node = document.createElement("p");
      appendInlineMarkdown(node, paragraph.join("\n"));
      container.append(node);
    }
    return container;
  }

  function startsMarkdownBlock(lines, index) {
    const line = lines[index];
    return (
      /^\s*```/.test(line) ||
      /^\s*#{1,4}\s+/.test(line) ||
      /^\s*>\s?/.test(line) ||
      /^\s*(?:[-+*]|\d+\.)\s+/.test(line) ||
      /^\s*(?:---+|\*\*\*+)\s*$/.test(line) ||
      isTableHeader(lines, index)
    );
  }

  function isTableHeader(lines, index) {
    return (
      lines[index]?.includes("|") &&
      /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1] || "")
    );
  }

  function splitTableRow(line) {
    return line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => cell.trim());
  }

  function appendInlineMarkdown(parent, text) {
    const source = String(text);
    const tokenPattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^)]+\))/g;
    let cursor = 0;
    for (const match of source.matchAll(tokenPattern)) {
      parent.append(document.createTextNode(source.slice(cursor, match.index)));
      const token = match[0];
      if (token.startsWith("`")) {
        const code = document.createElement("code");
        code.textContent = token.slice(1, -1);
        parent.append(code);
      } else if (token.startsWith("**") || token.startsWith("__")) {
        const strong = document.createElement("strong");
        strong.textContent = token.slice(2, -2);
        parent.append(strong);
      } else if (token.startsWith("*") || token.startsWith("_")) {
        const emphasis = document.createElement("em");
        emphasis.textContent = token.slice(1, -1);
        parent.append(emphasis);
      } else {
        const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        const href = safeLink(link?.[2]);
        if (link && href) {
          const anchor = document.createElement("a");
          anchor.textContent = link[1];
          anchor.href = href;
          anchor.target = "_blank";
          anchor.rel = "noopener noreferrer";
          parent.append(anchor);
        } else {
          parent.append(document.createTextNode(token));
        }
      }
      cursor = match.index + token.length;
    }
    parent.append(document.createTextNode(source.slice(cursor)));
  }

  function safeLink(value) {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
    } catch {
      return "";
    }
  }

  function markup() {
    return `
      <div class="mn-toolbar" data-visible="false" role="toolbar" aria-label="Doradude Cell 工具">
        <button class="mn-ask" type="button">Ask Codex</button>
        <button class="mn-fix" type="button">修复</button>
      </div>
      <aside class="mn-panel" data-open="false" aria-label="Doradude Notebook">
        <header>
          <div class="mn-brand">
            <img class="mn-brand-icon" alt="" width="34" height="34" />
            <div class="mn-brand-copy"><strong>Doradude</strong><span class="mn-context-label">Notebook + Codex</span></div>
          </div>
          <div class="mn-header-actions">
            <button class="mn-reset text-button" type="button" title="清除对话并新建会话">新对话</button>
            <button class="mn-theme icon" type="button" title="切换到深色" aria-label="切换到深色">☾</button>
            <button class="mn-settings icon" type="button" title="设置" aria-label="设置">⚙</button>
            <button class="mn-close icon" type="button" title="关闭侧栏" aria-label="关闭侧栏">×</button>
          </div>
        </header>
        <div class="mn-chat" aria-live="polite">
          <div class="mn-empty"><span>D</span><strong>从当前 Cell 开始</strong></div>
        </div>
        <div class="mn-composer">
          <div class="mn-actions" role="tablist" aria-label="操作类型">
            <button data-action="edit" data-selected="true" type="button">编辑</button>
            <button data-action="fix" type="button">修复</button>
            <button data-action="explain" type="button">解释</button>
            <button data-action="optimize" type="button">优化</button>
          </div>
          <textarea rows="3" maxlength="4000" aria-label="给 Codex 的指令"></textarea>
          <button class="mn-submit primary" type="button">发送</button>
        </div>
      </aside>`;
  }

  function styles() {
    return `<style>
      :host { color-scheme:light; --ink:#202124; --muted:#6b7078; --line:#d9dde3; --accent:#1769e0; --accent-strong:#0d56bd; --surface:#fff; font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; letter-spacing:0; }
      * { box-sizing:border-box; letter-spacing:0; }
      button,textarea { font:inherit; }
      button { cursor:pointer; }
      .mn-toolbar { position:fixed; display:flex; height:34px; align-items:center; overflow:hidden; background:#202124; border:1px solid #34373b; border-radius:6px; box-shadow:0 5px 18px rgba(0,0,0,.2); pointer-events:auto; opacity:0; visibility:hidden; transition:opacity .12s ease; }
      .mn-toolbar[data-visible="true"] { opacity:1; visibility:visible; }
      .mn-toolbar button { height:32px; border:0; border-right:1px solid #3d4147; padding:0 11px; color:#fff; background:transparent; font-size:12px; font-weight:600; }
      .mn-toolbar button:last-child { border-right:0; }
      .mn-toolbar button:hover { background:#34373b; }
      .mn-panel { position:fixed; inset:0 0 0 auto; display:grid; grid-template-rows:58px minmax(0,1fr) auto; width:min(440px,100vw); overflow:hidden; background:var(--surface); border-left:1px solid var(--line); box-shadow:-12px 0 36px rgba(24,28,36,.16); pointer-events:auto; opacity:0; visibility:hidden; transform:translateX(18px); transition:opacity .16s ease,transform .16s ease; color:var(--ink); }
      .mn-panel[data-open="true"] { opacity:1; visibility:visible; transform:translateX(0); }
      .mn-panel[data-docked="true"] { box-shadow:none; }
      header { display:flex; align-items:center; justify-content:space-between; min-width:0; padding:0 10px 0 16px; border-bottom:1px solid var(--line); background:#fff; }
      .mn-brand { min-width:0; display:flex; align-items:center; gap:9px; }
      .mn-brand-icon { width:34px; height:34px; flex:0 0 34px; border-radius:5px; object-fit:cover; }
      .mn-brand-copy { min-width:0; }
      .mn-brand strong { display:block; font-size:15px; line-height:18px; }
      .mn-brand span { display:block; max-width:190px; overflow:hidden; margin-top:1px; color:var(--muted); font-size:11px; line-height:14px; text-overflow:ellipsis; white-space:nowrap; }
      .mn-header-actions { display:flex; align-items:center; gap:2px; }
      .icon,.text-button { height:32px; border:0; background:transparent; color:#555b64; border-radius:4px; }
      .icon { width:32px; font-size:19px; line-height:1; }
      .text-button { padding:0 8px; font-size:12px; }
      .icon:hover,.text-button:hover { background:#f0f2f5; color:var(--ink); }
      .mn-chat { min-height:0; overflow:auto; padding:18px 16px 22px; background:#f6f7f9; overscroll-behavior:contain; }
      .mn-empty { height:100%; min-height:180px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; color:#7a818b; }
      .mn-empty[hidden] { display:none; }
      .mn-empty span { display:grid; place-items:center; width:34px; height:34px; border-radius:50%; background:#202124; color:#fff; font-size:15px; font-weight:700; }
      .mn-empty strong { font-size:13px; font-weight:600; }
      .mn-message { width:fit-content; max-width:92%; margin-bottom:14px; font-size:13px; line-height:1.55; }
      .mn-message p { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; }
      .mn-user-message { margin-left:auto; padding:10px 12px; border-radius:7px 7px 2px 7px; background:#1769e0; color:#fff; box-shadow:0 3px 10px rgba(23,105,224,.15); }
      .mn-message-meta { display:block; margin-bottom:3px; color:rgba(255,255,255,.72); font-size:10px; line-height:14px; }
      .mn-assistant-message { width:100%; max-width:100%; }
      .mn-reasoning { overflow:hidden; border:1px solid #d5dbe5; border-radius:6px; background:#fff; }
      .mn-reasoning summary { display:flex; align-items:center; justify-content:space-between; gap:10px; min-height:38px; padding:8px 10px; color:#45566e; cursor:pointer; font-size:12px; font-weight:600; list-style:none; }
      .mn-reasoning summary::-webkit-details-marker { display:none; }
      .mn-reasoning summary::before { content:""; width:8px; height:8px; flex:0 0 8px; border:2px solid #bdd1ee; border-top-color:var(--accent); border-radius:50%; animation:mn-spin .8s linear infinite; }
      .mn-reasoning:not([open]) summary::before { border:solid #758399; border-width:0 1.5px 1.5px 0; border-radius:0; transform:rotate(-45deg); animation:none; }
      .mn-reasoning-title { min-width:0; flex:1; }
      .mn-reasoning-time { flex:0 0 auto; color:#8490a0; font-size:10px; font-weight:500; }
      .mn-reasoning-content { max-height:260px; overflow:auto; margin:0; padding:0 10px 11px 28px; color:#596777; overflow-wrap:anywhere; font-size:11px; line-height:1.55; }
      .mn-process-line { display:grid; grid-template-columns:34px minmax(0,1fr); gap:7px; padding:2px 0; }
      .mn-process-time { color:#8a95a4; font:10px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace; white-space:nowrap; }
      .mn-process-message { min-width:0; }
      .mn-process-message p { margin:0; }
      .mn-process-reasoning { margin:5px 0 3px 41px; padding:7px 9px; border-left:2px solid #a9c3e8; background:#f6f8fb; color:#4d5c6e; }
      @keyframes mn-spin { to { transform:rotate(360deg); } }
      .mn-answer { margin-top:8px; padding:11px 12px; border:1px solid var(--line); border-radius:6px 6px 6px 2px; background:#fff; box-shadow:0 3px 12px rgba(30,38,52,.06); }
      .mn-summary,.mn-explanation { color:#3f464f; }
      .mn-explanation { margin-top:9px; color:#626a75; }
      .mn-markdown > :first-child { margin-top:0; }
      .mn-markdown > :last-child { margin-bottom:0; }
      .mn-markdown p { margin:0 0 8px; white-space:pre-wrap; }
      .mn-markdown h3,.mn-markdown h4,.mn-markdown h5,.mn-markdown h6 { margin:12px 0 6px; color:#252b33; font-size:13px; line-height:1.4; }
      .mn-markdown ul,.mn-markdown ol { margin:6px 0 9px; padding-left:20px; }
      .mn-markdown li { margin:3px 0; }
      .mn-markdown code { padding:1px 4px; border-radius:3px; background:#edf0f4; color:#9b2f54; font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace; }
      .mn-markdown-code { max-height:260px; overflow:auto; margin:8px 0; padding:10px; border:1px solid #dde1e7; border-radius:5px; background:#f7f8fa; white-space:pre; }
      .mn-markdown-code code { padding:0; background:transparent; color:#25282d; }
      .mn-markdown blockquote { margin:8px 0; padding:5px 9px; border-left:3px solid #9db9df; background:#f5f8fc; color:#526173; white-space:pre-wrap; }
      .mn-markdown a { color:#0d62c7; text-decoration:underline; text-underline-offset:2px; }
      .mn-markdown hr { margin:10px 0; border:0; border-top:1px solid #dfe3e8; }
      .mn-markdown table { width:100%; margin:8px 0; border-collapse:collapse; font-size:11px; }
      .mn-markdown th,.mn-markdown td { padding:6px 7px; border:1px solid #d9dee5; text-align:left; vertical-align:top; }
      .mn-markdown th { background:#f1f4f8; color:#394554; font-weight:650; }
      .mn-code { max-height:320px; overflow:auto; margin:10px 0 0; padding:11px; border:1px solid #dde1e7; border-radius:5px; background:#f7f8fa; color:#25282d; white-space:pre; tab-size:4; font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace; }
      .mn-error { color:#a62b22; }
      .mn-result-actions { display:flex; justify-content:flex-end; margin-top:10px; }
      .mn-result-actions button { min-height:34px; border-radius:5px; padding:0 12px; font-size:12px; }
      button.primary { border:1px solid var(--accent); background:var(--accent); color:#fff; font-weight:650; }
      button.primary:hover { background:var(--accent-strong); }
      button.primary:disabled { cursor:wait; opacity:.65; }
      .mn-composer { padding:12px 14px 14px; border-top:1px solid var(--line); background:#fff; }
      .mn-actions { display:grid; grid-template-columns:repeat(4,1fr); margin-bottom:8px; border:1px solid var(--line); border-radius:6px; overflow:hidden; }
      .mn-actions button { height:32px; border:0; border-right:1px solid var(--line); background:#fff; color:#555b64; font-size:12px; }
      .mn-actions button:last-child { border-right:0; }
      .mn-actions button[data-selected="true"] { background:#eaf2ff; color:#0d56bd; font-weight:650; }
      textarea { width:100%; min-height:72px; max-height:180px; resize:vertical; display:block; padding:9px 10px; border:1px solid #bcc2ca; border-radius:6px; color:var(--ink); background:#fff; font-size:13px; line-height:1.5; outline:none; }
      textarea:focus { border-color:var(--accent); box-shadow:0 0 0 2px rgba(23,105,224,.14); }
      .mn-submit { width:100%; height:36px; margin-top:8px; border-radius:6px; font-size:13px; }
      .mn-panel[data-theme="dark"] { --ink:#e7e9ed; --muted:#9ca4af; --line:#3a3f47; --accent:#4d96f4; --accent-strong:#337fdc; --surface:#202226; color-scheme:dark; background:#202226; border-left-color:#3a3f47; box-shadow:-12px 0 36px rgba(0,0,0,.42); }
      .mn-panel[data-theme="dark"] header,
      .mn-panel[data-theme="dark"] .mn-composer { background:#202226; border-color:#3a3f47; }
      .mn-panel[data-theme="dark"] .mn-chat { background:#17191c; }
      .mn-panel[data-theme="dark"] .icon,
      .mn-panel[data-theme="dark"] .text-button { color:#b2b8c1; }
      .mn-panel[data-theme="dark"] .icon:hover,
      .mn-panel[data-theme="dark"] .text-button:hover { background:#30343a; color:#f2f3f5; }
      .mn-panel[data-theme="dark"] .mn-reasoning,
      .mn-panel[data-theme="dark"] .mn-answer { border-color:#3a4049; background:#25282d; box-shadow:none; }
      .mn-panel[data-theme="dark"] .mn-reasoning summary { color:#c4d2e5; }
      .mn-panel[data-theme="dark"] .mn-reasoning-content { color:#aab2be; }
      .mn-panel[data-theme="dark"] .mn-process-time { color:#7f8996; }
      .mn-panel[data-theme="dark"] .mn-process-reasoning { border-left-color:#668fca; background:#1c2026; color:#c0c8d3; }
      .mn-panel[data-theme="dark"] .mn-summary,
      .mn-panel[data-theme="dark"] .mn-explanation { color:#d1d5db; }
      .mn-panel[data-theme="dark"] .mn-markdown h3,
      .mn-panel[data-theme="dark"] .mn-markdown h4,
      .mn-panel[data-theme="dark"] .mn-markdown h5,
      .mn-panel[data-theme="dark"] .mn-markdown h6 { color:#f0f1f3; }
      .mn-panel[data-theme="dark"] .mn-markdown code { background:#343941; color:#f3a6be; }
      .mn-panel[data-theme="dark"] .mn-code,
      .mn-panel[data-theme="dark"] .mn-markdown-code { border-color:#41464f; background:#191b1f; color:#e1e4e8; }
      .mn-panel[data-theme="dark"] .mn-markdown-code code { color:#e1e4e8; }
      .mn-panel[data-theme="dark"] .mn-markdown blockquote { border-left-color:#668fca; background:#292f38; color:#bdc6d2; }
      .mn-panel[data-theme="dark"] .mn-markdown a { color:#75adf5; }
      .mn-panel[data-theme="dark"] .mn-markdown hr,
      .mn-panel[data-theme="dark"] .mn-markdown th,
      .mn-panel[data-theme="dark"] .mn-markdown td { border-color:#41464f; }
      .mn-panel[data-theme="dark"] .mn-markdown th { background:#30343a; color:#dce2ea; }
      .mn-panel[data-theme="dark"] .mn-actions { border-color:#41464f; }
      .mn-panel[data-theme="dark"] .mn-actions button { border-color:#41464f; background:#25282d; color:#b9c0ca; }
      .mn-panel[data-theme="dark"] .mn-actions button[data-selected="true"] { background:#263d5d; color:#8fc0ff; }
      .mn-panel[data-theme="dark"] textarea { border-color:#555c66; background:#191b1f; color:#eceef1; }
      .mn-panel[data-theme="dark"] textarea::placeholder { color:#7e8793; }
      @media (max-width:560px) { .mn-panel { width:100vw; } .mn-chat { padding-inline:12px; } }
    </style>`;
  }

  namespace.DoradudeUI = DoradudeUI;
})();
