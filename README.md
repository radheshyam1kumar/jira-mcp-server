# jira-mcp-server

A standalone [Model Context Protocol](https://modelcontextprotocol.io/) server for **Jira Cloud**. It exposes tools that agents (for example Cursor) can call to pull ticket context. The layout is meant to grow into broader **AI-driven development** flows (repo analysis, execution pipelines, GitHub linking) without rewriting the core server.

## Prerequisites

- **Node.js 18+** recommended (matches `@modelcontextprotocol/sdk` engines). Outbound Jira calls use **axios** and Node `https`, not global `fetch`.

## Setup

1. Clone or copy this repository anywhere on your machine (it is **not** tied to your React app).

2. Install dependencies:

   ```bash
   npm install
   ```

3. Configure environment variables:

   ```bash
   cp .env.example .env
   ```

   Edit `.env`:

   | Variable           | Description |
   | ------------------ | ----------- |
   | `JIRA_DOMAIN`      | Your Jira Cloud host, e.g. `your-company.atlassian.net` (no `https://`) |
   | `JIRA_EMAIL`       | Atlassian account email used for the API token |
   | `JIRA_API_TOKEN`   | API token (see below) |

### TLS and corporate networks

If attachment downloads or API calls fail with **“unable to get local issuer certificate”**, Node cannot trust your TLS inspection certificate.

1. **Recommended:** Export your corporate root/intermediate CA as PEM and set **`JIRA_EXTRA_CA_FILE`** (or **`JIRA_CA_BUNDLE_PATH`**) in `.env` to that file path. The server merges it with Node’s built-in roots for **all** Jira HTTPS traffic (REST + attachments), using **axios** and Node’s `https` stack.
2. **Alternative:** Set **`NODE_EXTRA_CA_CERTS`** to the same PEM path (standard Node; applies process-wide).
3. **Dev only:** **`JIRA_TLS_INSECURE=true`** or **`JIRA_ATTACHMENT_TLS_INSECURE=true`** disables certificate verification. Do not use on untrusted networks.

## Jira API token

1. Open [Atlassian API tokens](https://id.atlassian.com/manage-profile/security/api-tokens).
2. Create a token and copy it into `JIRA_API_TOKEN` in `.env`.
3. Ensure your Atlassian user can **browse** the issues you request.

Authentication uses **HTTP Basic** with `email:api_token` as documented in [Jira Cloud REST v3](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/#authentication).

## Run the server

From the project root:

```bash
node src/server.js
```

Or:

```bash
npm start
```

The process speaks **MCP over stdio**. You should not run it in a normal terminal expecting interactive output on stdout; stdout is reserved for JSON-RPC. Logs are written to **stderr** as structured JSON lines.

## MCP tool: `jira_get_issue`

**Input**

- `issueKey` (string) — e.g. `IPG-754`

**Behavior**

- Calls `GET /rest/api/3/issue/{issueKey}` on your Jira Cloud site.
- Returns a JSON payload (as tool result text) with:

  ```json
  {
    "issueKey": "IPG-754",
    "summary": "...",
    "description": "...",
    "status": "In Progress",
    "assignee": "Name or null",
    "attachments": [
      {
        "fileName": "screenshot.png",
        "mimeType": "image/png",
        "url": "https://your-domain.atlassian.net/rest/api/3/attachment/content/12345"
      }
    ]
  }
  ```

- `attachments` comes from `fields.attachment` (empty array if none).
- Rich text descriptions are reduced to **plain text** (Atlassian Document Format is walked best-effort).

**Errors**

Failures return JSON with `error: true`, a stable `code` (e.g. `INVALID_KEY`, `UNAUTHORIZED`, `ISSUE_NOT_FOUND`, `NETWORK_ERROR`), and a short `message` suitable for models.

## MCP tool: `jira_get_attachments_content`

**Input**

- `attachments` (array) — objects with `url` (required), `fileName` or `filename`, and `mimeType` (as returned by `jira_get_issue.attachments`).

**Behavior**

- Keeps only **image** MIME types: `image/png`, `image/jpeg`, `image/jpg`, `image/webp`.
- Downloads each URL with the same Jira Basic auth as `jira_get_issue`.
- Returns JSON array of `{ fileName, mimeType, base64 }`.
- Skips failed downloads (logs to stderr); does **not** run image analysis.
- Per-file size cap: **20 MB** (skipped with log if larger).
- If every attempted image download returns **401**, the tool returns an auth error payload instead of an empty list.

**Typical flow**

1. `jira_get_issue` → read `attachments`.
2. `jira_get_attachments_content` with those objects → pass `base64` + `mimeType` to your client / vision model.

**Browser download works but MCP fails?**

- The browser uses your **Atlassian session** (cookies). The MCP server uses **HTTP Basic** (`JIRA_EMAIL` + `JIRA_API_TOKEN`) on the same `.../attachment/content/{id}` URL. Both are valid; they are different auth paths.
- If Node errors with **`unable to get local issuer certificate`**, your machine does not trust the TLS chain Node sees (often **corporate SSL inspection**). **Preferred fix:** `export NODE_EXTRA_CA_CERTS=/path/to/your-corporate-root-CA.pem` before starting Cursor / the MCP process.
- **Dev-only alternative:** set `JIRA_ATTACHMENT_TLS_INSECURE=true` in `jira-mcp-server/.env` to download attachments with `https` and `rejectUnauthorized: false` (see `src/utils/downloadAttachment.js`). Do not use on untrusted networks.
- Corporate proxy may also need `HTTPS_PROXY` / `HTTP_PROXY` for Node.

## Connect in Cursor

Use **Settings → MCP** (or your `mcp.json`), and point Cursor at this project so `src/server.js` resolves correctly.

**Important:** set **`cwd`** to this repository’s root if your `args` are relative paths.

```json
{
  "mcpServers": {
    "jira-context-server": {
      "command": "node",
      "args": ["src/server.js"],
      "cwd": "/absolute/path/to/jira-mcp-server"
    }
  }
}
```

Replace `/absolute/path/to/jira-mcp-server` with the real path on your machine.

After saving, restart Cursor or reload MCP. You should see the server and tools `jira_get_issue`, `jira_get_attachments_content`.

## Project layout & extension points

| Path | Role |
| ---- | ---- |
| `src/server.js` | Stdio transport, **tool registrar list** — add new modules here |
| `src/tools/jiraGetIssueTools.js` | `jira_get_issue` |
| `src/tools/jiraAttachmentsTools.js` | `jira_get_attachments_content` |
| `src/services/jiraService.js` | Jira HTTP client, auth, parsing, attachments + image fetch |
| `src/utils/downloadAttachment.js` | Authenticated binary download helper |
| `src/utils/auth.js` | Basic auth header |
| `src/utils/logger.js` | stderr JSON logging |
| `src/config/env.js` | Env load / validation |

**Future (commented patterns in `server.js`):**

- `src/tools/repoTools.js` — workspace/repo analysis tools
- `src/tools/executionTools.js` — longer-running automation / implementation flows
- **GitHub:** add something like `src/services/githubService.js` and register tools next to Jira

Adding a new capability should be: **new service (if needed) → new `register*Tools` → one line in `toolRegistrars`**.

## License

MIT
