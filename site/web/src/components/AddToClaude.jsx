// "Add to Claude". Claude has no deep link that installs a custom connector,
// so the button does the next best thing in one click: copy the storefront URL,
// open Claude's connector screen in a new tab, and lay out the fields the
// buyer still has to paste.
import { useState } from "react";
import { copyText } from "../lib/copy.js";
import { Value } from "./Copy.jsx";

const CONNECTORS_URL = "https://claude.ai/customize/connectors";
const READY = /^https:\/\/[^<>\s]+\.snowflakecomputing\.com\/api\/v2\//;

export default function AddToClaude({ name = "Sales desk", url = "", clientId = "", toolName = "counteroffer", pendingNote }) {
  const desk = (name || "Sales desk").trim();
  const u = (url || "").trim();
  const cid = (clientId || "").trim();
  const ready = READY.test(u);
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState(false);

  async function addToClaude() {
    await copyText(u);
    setOpen(true);
    const w = window.open(CONNECTORS_URL, "_blank", "noopener");
    setStatus(w
      ? "URL copied and Claude opened in a new tab. Paste it into Add custom connector; the steps below have the rest."
      : "URL copied. Your browser blocked the new tab, so open Claude's connector settings from the link below.");
  }
  async function addToClaudeCode() {
    await copyText('claude mcp add --transport http "' + (toolName || "counteroffer") + '" ' + u);
    setOpen(true);
    setStatus("Command copied. Paste it in your terminal, then run /mcp in Claude Code to sign in.");
  }

  return (
    <div className="atc">
      <div className="atc-id">
        <span className="atc-mark" aria-hidden="true">{(desk[0] || "C").toUpperCase()}</span>
        <div>
          <div className="atc-name">{desk}</div>
          <div className="atc-kind">Custom connector over MCP</div>
        </div>
      </div>

      <div className="atc-actions">
        <button type="button" className="btn btn-primary" disabled={!ready} onClick={addToClaude}>Add to Claude</button>
        <button type="button" className="btn" disabled={!ready} onClick={addToClaudeCode}>Add to Claude Code</button>
      </div>
      <p className="atc-status" role="status">
        {ready ? status : (pendingNote || "Add the storefront URL to turn this button on.")}
      </p>

      {open && ready && (
        <ol className="atc-steps">
          <li>In the Claude tab that opened, choose <b>Add</b>, then <b>Add custom connector</b>.</li>
          <li>Name it:<Value>{desk}</Value></li>
          <li>Remote MCP server URL (already on your clipboard):<Value>{u}</Value></li>
          <li>
            Open <b>Advanced settings</b>, choose <b>Use your own OAuth client</b>, and paste the client ID
            {cid ? ":" : " the seller sent you."}
            {cid && <Value>{cid}</Value>}
          </li>
          <li>Choose <b>Connect</b>, sign in and approve. Then set the {desk} tool to <b>Always allow</b>.</li>
          <li className="atc-fallback">Tab didn't open? <a href={CONNECTORS_URL} target="_blank" rel="noopener noreferrer">Open Claude's connector settings</a>.</li>
        </ol>
      )}
    </div>
  );
}
