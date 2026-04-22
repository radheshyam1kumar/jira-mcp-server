# Dummy demo — AI DevOps Dashboard (mock)

Follow this script for a **~5 minute** walkthrough. No real server; everything is in-browser with fake delays and timers.

---

## 0. Start

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173** (browser or Cursor Simple Browser).

---

## 1. First screen (~300 ms after load)

| Area | What you see |
|------|----------------|
| **Left — Job list** | Three seeded jobs, e.g. `PROJ-3423` (running), `PROJ-3310` (completed), `PROJ-3299` (failed). |
| **Right — Details** | First job in sort order is selected: pipeline steps, progress bar, logs, deployment line. |

The **running** job updates on its own (mock timer + `subscribeToTaskUpdates`). **Logs** refresh about every **900 ms** via polling (`getTaskLogs`).

---

## 2. Demo script

### A — “Live” task + logs

1. Click **`PROJ-3423`** (running).
2. Watch **progress** and **status** move toward **Completed**.
3. Scroll **Activity logs** — lines append while the job is active.

### B — Completed job + PR

1. Click **`PROJ-3310`** (or filter **Completed**).
2. In **Pull request**, open **View PR** or **Copy link** (fake URL).

### C — Failed job + retry

1. Click **`PROJ-3299`** (**Failed**).
2. Read logs / deployment line.
3. Click **Retry (mock)** — job becomes **pending → running** and the mock **forces success** so it should finish **Completed**.

### D — New job

1. In **New task name…**, type `Demo: dark mode toggle`.
2. Click **Create**.
3. A row like **`JOB-xxxxxxxx`** appears; selection jumps to it. It goes **pending → running → completed** (or sometimes **failed**, random in mock).

### E — Filters + search

1. Use **All / Running / Completed**.
2. Search **`PROJ`** — list narrows by id or name.

### F — Error handling (one click)

1. In the header, click **Demo: fail load** — the next list request is forced to fail; an **error banner** appears.
2. Click **Retry fetch** — list loads again; banner clears when successful.
3. Optional: **Fail again (demo)** on the banner repeats the failure; **Dismiss** clears the message without refetching.

---

## 3. What is *not* real yet

| Feature | Current behavior |
|---------|-------------------|
| Task stream | In-memory **callbacks** from the mock (same hook you’d use for **WebSocket** later). |
| Log stream | **HTTP polling**, not WebSocket/SSE. |
| PR / deploy buttons | Alerts or copy only — placeholders. |

---

## 4. Files to peek at while demoing

- `src/mocks/mockTaskService.ts` — timers, seeds, `notify`.
- `src/hooks/useTaskDashboardStore.ts` — `initialize`, `upsertTask`, subscription wiring.
- `src/hooks/useTaskLogs.ts` — polling interval for logs.

For architecture detail see **`DOCS.md`**.
