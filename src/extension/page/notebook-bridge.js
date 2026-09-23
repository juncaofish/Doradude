(() => {
  if (window.__DORADUDE_NOTEBOOK_BRIDGE__) return;
  window.__DORADUDE_NOTEBOOK_BRIDGE__ = true;

  const requestEvent = "doradude:notebook-request";
  const responseEvent = "doradude:notebook-response";

  window.addEventListener(requestEvent, async (event) => {
    const request = event.detail;
    if (!request?.id || !request?.operation) return;

    try {
      const cell = document.querySelector(`[data-doradude-cell-id="${cssEscape(request.cellId)}"]`);
      if (!cell) throw new Error("Notebook cell is no longer available");
      const editor = await findEditor(cell);
      let result;

      if (request.operation === "read") {
        result = readEditor(editor, cell);
      } else if (request.operation === "replace") {
        result = writeEditor(editor, cell, request.code);
      } else {
        throw new Error(`Unsupported notebook operation: ${request.operation}`);
      }

      respond(request.id, { ok: true, result });
    } catch (error) {
      respond(request.id, { ok: false, error: error.message });
    }
  });

  async function findEditor(cell) {
    const monaco = await findMonaco();
    if (monaco?.editor) {
      const editor = monaco.editor.getEditors?.().find((candidate) => {
        const node = candidate.getDomNode?.();
        return node && cell.contains(node);
      });
      if (editor) return { kind: "monaco", editor };

      const uri = cell.querySelector(".monaco-editor[data-uri]")?.getAttribute("data-uri");
      const model = monaco.editor.getModels?.().find((candidate) => String(candidate.uri) === uri);
      if (model) return { kind: "monaco-model", model };
    }

    const codeMirrorNode = cell.querySelector(".CodeMirror");
    if (codeMirrorNode?.CodeMirror) {
      return { kind: "codemirror5", editor: codeMirrorNode.CodeMirror };
    }

    return null;
  }

  async function findMonaco() {
    if (window.monaco?.editor) return window.monaco;
    for (const loader of [window.require, window.requirejs]) {
      if (typeof loader !== "function") continue;
      for (const moduleId of ["vs/editor/editor.api", "vs/editor/editor.main"]) {
        try {
          const loaded = loader(moduleId);
          if (loaded?.editor) return loaded;
          if (loaded?.default?.editor) return loaded.default;
        } catch {}
      }
      if (!loader.config && !loader.amd) continue;
      const loaded = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 300);
        try {
          loader(
            ["vs/editor/editor.main"],
            (value) => {
              clearTimeout(timer);
              resolve(value?.editor ? value : value?.default || null);
            },
            () => {
              clearTimeout(timer);
              resolve(null);
            }
          );
        } catch {
          clearTimeout(timer);
          resolve(null);
        }
      });
      if (loaded?.editor) return loaded;
    }
    return null;
  }

  function readEditor(found, cell) {
    if (found?.kind === "monaco") {
      const model = found.editor.getModel();
      const selection = found.editor.getSelection?.();
      return {
        source: model?.getValue() || "",
        selection: selection && model ? model.getValueInRange(selection) : "",
        language: model?.getLanguageId?.() || ""
      };
    }
    if (found?.kind === "monaco-model") {
      return {
        source: found.model.getValue(),
        selection: "",
        language: found.model.getLanguageId?.() || ""
      };
    }
    if (found?.kind === "codemirror5") {
      return {
        source: found.editor.getValue(),
        selection: found.editor.getSelection(),
        language: found.editor.getOption("mode")?.name || ""
      };
    }

    const input = cell.querySelector("textarea");
    if (input?.closest(".monaco-editor")) throw new Error("Monaco model is not accessible");
    if (input) {
      return {
        source: input.value,
        selection: input.value.slice(input.selectionStart, input.selectionEnd),
        language: ""
      };
    }
    throw new Error("No supported editor found in this cell");
  }

  function writeEditor(found, cell, code) {
    if (typeof code !== "string") throw new Error("Replacement code must be a string");
    if (found?.kind === "monaco") {
      const model = found.editor.getModel();
      if (!model) throw new Error("Monaco model is unavailable");
      found.editor.pushUndoStop?.();
      const applied = found.editor.executeEdits("doradude", [{ range: model.getFullModelRange(), text: code }]);
      if (applied === false || model.getValue() !== code) replaceMonacoModel(model, code);
      found.editor.pushUndoStop?.();
      found.editor.focus?.();
      if (model.getValue() !== code) throw new Error("Monaco rejected the replacement");
      return { applied: true, source: model.getValue() };
    }
    if (found?.kind === "monaco-model") {
      replaceMonacoModel(found.model, code);
      if (found.model.getValue() !== code) throw new Error("Monaco rejected the replacement");
      return { applied: true, source: found.model.getValue() };
    }
    if (found?.kind === "codemirror5") {
      found.editor.setValue(code);
      found.editor.focus();
      if (found.editor.getValue() !== code) throw new Error("CodeMirror rejected the replacement");
      return { applied: true, source: found.editor.getValue() };
    }

    const input = cell.querySelector("textarea");
    if (input?.closest(".monaco-editor")) throw new Error("Monaco model is not accessible");
    if (!input) throw new Error("No writable editor found in this cell");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(input, code);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: code }));
    if (input.value !== code) throw new Error("Editor rejected the replacement");
    return { applied: true, source: input.value };
  }

  function replaceMonacoModel(model, code) {
    const edit = { range: model.getFullModelRange(), text: code };
    model.pushStackElement?.();
    if (typeof model.pushEditOperations === "function") model.pushEditOperations([], [edit], () => null);
    else if (typeof model.applyEdits === "function") model.applyEdits([edit]);
    else model.setValue(code);
    model.pushStackElement?.();
  }

  function respond(id, payload) {
    window.dispatchEvent(new CustomEvent(responseEvent, { detail: { id, ...payload } }));
  }

  function cssEscape(value) {
    return window.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/["\\]/g, "\\$&");
  }
})();
