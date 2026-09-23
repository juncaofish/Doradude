# Doradude

Doradude is a Chromium extension for using Codex beside DataLeap Notebook cells. It reads the current cell, selection, nearby cells, and recent output, then shows Codex suggestions before any notebook change is applied.

## Architecture

```text
DataLeap Notebook
  -> Doradude content script + Notebook Adapter
  -> Doradude Bridge (HTTP, local or remote)
  -> one persistent codex app-server process
  -> one Codex thread per Notebook URL
```

The extension never gives Codex direct write access to DataLeap. Codex runs with a read-only sandbox and returns structured `replace`, `insert`, or `explain` suggestions. The browser writes code only after the user clicks the apply button.

## Requirements

- Node.js 20 or newer
- A current Codex CLI available as `codex`
- Codex CLI authentication already configured on the machine running the Bridge
- A Chromium browser with Manifest V3 support

## Run locally

Build the extension:

```bash
npm run build
```

Start the Bridge:

```bash
npm run bridge
```

Then open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `dist/extension`. The settings page opens on first install. Keep the default endpoint `http://127.0.0.1:4343`, grant access when prompted, and use **Test connection**.

Open a DataLeap Notebook and hover over a code cell. Choose **Ask Codex** or **Fix** to open the persistent right sidebar. The sidebar keeps the current page's chat history, streams available Codex reasoning summaries and progress, and collapses the reasoning section when the final answer arrives. Review returned code before explicitly applying it.

## Create a release

Run the tests, rebuild the extension, and create a versioned ZIP in one command:

```bash
npm run release
```

The command writes `dist/releases/doradude-<version>.zip` and its `.sha256` checksum. On macOS, unzip the archive, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the extracted directory. Chrome does not install an unsigned ZIP directly.

## Session behavior

Doradude keeps a single `codex app-server` subprocess alive behind the Bridge. The first request for a Notebook starts a Codex thread; later requests for the same normalized Notebook URL start turns on that thread. The URL-to-thread mapping is stored at `~/.doradude/sessions.json`, so the Bridge can use `thread/resume` after a restart.

Each request still includes the latest visible Cell context. Thread memory is useful for follow-up instructions and prior decisions, while current page content remains authoritative. Use **New chat / 新对话** in the sidebar to clear the visible history, detach the Notebook from its previous thread, and start fresh on the next request.

## Remote Bridge

The safest remote setup is to keep the Bridge on loopback and use an SSH tunnel:

```bash
ssh -N -L 4343:127.0.0.1:4343 your-development-host
```

For a directly reachable service, bind to a non-loopback address only with a token and put TLS in front of it:

```bash
DORADUDE_HOST=0.0.0.0 \
DORADUDE_TOKEN='replace-with-a-long-random-token' \
npm run bridge
```

Set the HTTPS endpoint and the same token in the extension. The Bridge refuses non-loopback binding without `DORADUDE_TOKEN`.

Optional environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `DORADUDE_HOST` | `127.0.0.1` | HTTP listen address |
| `DORADUDE_PORT` | `4343` | HTTP listen port |
| `DORADUDE_TOKEN` | empty on loopback | Bearer token |
| `DORADUDE_CODEX_BIN` | `codex` | Codex executable |
| `DORADUDE_CODEX_MODEL` | Codex default | Optional model override |
| `DORADUDE_TIMEOUT_MS` | `150000` | Turn timeout |
| `DORADUDE_STATE_DIR` | `~/.doradude` | Session mapping and empty workspaces |
| `DORADUDE_ALLOWED_ORIGINS` | empty | Extra comma-separated browser origins |

## Notebook Adapter

DataLeap uses a customized JupyterLab interface with Monaco Editor. Doradude first locates Jupyter/DataLeap cell containers and accesses Monaco from a small main-world bridge. It falls back to CodeMirror 5 or a textarea when available.

If a DataLeap deployment uses different cell markup, set a custom CSS Cell selector in extension settings. All DataLeap-specific discovery and write logic lives in `src/extension/content/adapter.js`.

## Development

```bash
npm test
npm run build
```

The project intentionally has no npm runtime dependencies. The Bridge uses Node.js built-ins and the extension ships as plain browser JavaScript.

## Icon source

The Doradude icon is a transformed crop of Nick L'Ange's [El Dorado Native King](https://cdnb.artstation.com/p/assets/images/images/004/229/051/large/nick-l-ange-el-dorado-native-king-full-colour-new.jpg?1481557538), supplied by the project owner for this use. The source artwork is marked as all rights reserved on its [ArtStation project page](https://nicklange.artstation.com/projects/Odaa6). Confirm redistribution rights with the artist before publishing the extension outside your organization.
