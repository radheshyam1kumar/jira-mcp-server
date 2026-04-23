#!/usr/bin/env python3
"""One-off generator: manager summary PDF for token/cost pipeline work."""

from pathlib import Path

from fpdf import FPDF

OUT = Path(__file__).resolve().parent.parent / "docs" / "Jira-MCP-Token-Cost-Dashboard-Summary.pdf"


class PDF(FPDF):
    def header(self):
        self.set_font("Helvetica", "B", 14)
        self.cell(0, 10, "Jira MCP pipeline: LLM tokens & cost", ln=True)
        self.set_font("Helvetica", "", 9)
        self.set_text_color(80, 80, 80)
        self.cell(0, 5, "Engineering summary for stakeholders | April 2026", ln=True)
        self.ln(4)
        self.set_text_color(0, 0, 0)

    def footer(self):
        self.set_y(-15)
        self.set_font("Helvetica", "I", 8)
        self.set_text_color(128, 128, 128)
        self.cell(0, 10, f"Page {self.page_no()}", align="C")
        self.set_text_color(0, 0, 0)

    def section(self, title: str):
        self.ln(2)
        self.set_font("Helvetica", "B", 11)
        self.multi_cell(0, 6, title)
        self.ln(1)

    def body_text(self, text: str):
        self.set_font("Helvetica", "", 10)
        self.multi_cell(0, 5, text)


SECTIONS = [
    (
        "1. Purpose",
        "We needed the internal Jira job dashboard to show LLM token totals and estimated USD cost "
        "per ticket, including when engineers develop in Cursor (not only via Bitbucket MCP). "
        "Cursor does not expose official per-message token usage to our MCP server, so we added "
        "explicit MCP tools plus an optional Cursor hook that posts estimated usage automatically.",
    ),
    (
        "2. Backend (existing + unchanged contract)",
        "The pipeline API accepts LLM_USAGE events with issueKey, phase, model, and usage fields. "
        "The repository merges usage per phase inside the active pipeline run. extractUsage() maps "
        "Anthropic-style (input_tokens / output_tokens) and OpenAI-style (prompt_tokens / "
        "completion_tokens) into internal counts. calculatePhaseCost() applies rates from "
        "modelPricing.js (e.g. Claude Sonnet / Opus). Official accuracy requires provider-reported usage.",
    ),
    (
        "3. New MCP tools (explicit updates)",
        "jira_pipeline_record_llm_usage: send real token counts when available from an API/SDK. "
        "jira_pipeline_mark_local_work: mark development or commit SUCCESS for local / Cursor git flows. "
        "jira_pipeline_update_stage: generic stage updates. pipelineTracker.sendEvent now returns "
        "ok/error and parsed ticket JSON when the API responds successfully.",
    ),
    (
        "4. Cursor hook (automatic, estimated)",
        "File: jira-mcp-server/scripts/cursor-hook-after-agent-response.mjs. "
        "Configured in workspace .cursor/hooks.json on afterAgentResponse. "
        "Each assistant reply: resolves Jira key (last PROJ-123 match in reply or transcript tail); "
        "estimates completion tokens from UTF-8 length of reply / 4; estimates prompt delta from "
        "transcript file growth since the previous reply for the same conversation_id; maps model "
        "string to claude-opus-4-6 or claude-sonnet-4-6 for pricing; POSTs ENSURE then LLM_USAGE. "
        "Requires PIPELINE_API_BASE_URL and optional PIPELINE_INTERNAL_SECRET in Cursor's environment. "
        "Disable with PIPELINE_AUTO_USAGE=0. Phase label default: cursor_agent (PIPELINE_USAGE_PHASE).",
    ),
    (
        "5. Accuracy (for management)",
        "Hook-based numbers are heuristics, not invoice-grade. They are useful for trends and "
        "relative load, not financial audit. There is no single stable percentage error: it depends "
        "on code vs prose, tool output volume, transcript format, and provider behaviour. For audit "
        "or billing reconciliation, use jira_pipeline_record_llm_usage with real API usage objects.",
    ),
    (
        "6. Operational checklist",
        "1) Pipeline API reachable from the machine running Cursor hooks. "
        "2) Same URL/secret as MCP where applicable. "
        "3) Mention the Jira key (e.g. PG-3478) in the thread so attribution works. "
        "4) Use jira_pipeline_mark_local_work or Bitbucket tools for stage alignment when needed.",
    ),
]


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    pdf = PDF()
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.add_page()
    for title, body in SECTIONS:
        pdf.section(title)
        pdf.body_text(body)
    pdf.output(str(OUT))
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
