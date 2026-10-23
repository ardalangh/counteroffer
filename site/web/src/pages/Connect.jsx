// Buyer page: /connect?n=<desk name>&u=<storefront url>&c=<client id>&t=<tool name>
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import Logo from "../components/Logo.jsx";
import AddToClaude from "../components/AddToClaude.jsx";
import { CodeBlock } from "../components/Copy.jsx";
import "../styles/connect.css";

// Only ever render a Snowflake-managed MCP endpoint; anything else counts as missing.
const VALID = /^https:\/\/[A-Za-z0-9.-]+\.snowflakecomputing\.com\/api\/v2\/[\w/\-.]+$/;

const MANDATE = `# Example mandate
Lane: <origin> to <destination>
Volume: <loads per week>
Max contract term: <months>
Ceiling price per load: <$ amount>
Negotiate with the seller's sales desk. Trade concessions only
within this mandate. Ask me before booking anything.`;

export default function Connect() {
  const [q] = useSearchParams();
  const name = (q.get("n") || "").slice(0, 80);
  const toolName = (q.get("t") || "counteroffer").replace(/[^a-z0-9_]/gi, "").slice(0, 40) || "counteroffer";
  const [url, setUrl] = useState((q.get("u") || "").trim());
  const [clientId, setClientId] = useState((q.get("c") || "").trim().slice(0, 200));
  const ok = VALID.test(url);
  const title = ok ? "Add " + (name || "this storefront") + " to Claude" : "Add a storefront to Claude";

  useEffect(() => { document.title = title + " · Counteroffer"; }, [title]);

  return (
    <div className="connect">
      <header className="connect-top"><div className="wrap"><Logo /></div></header>
      <main className="wrap connect-main" id="main">
        <h1>{title}</h1>
        <p className="connect-lede">
          One click copies the connector URL and opens the right screen in Claude. Your agent then
          negotiates with the seller's agent directly. Connecting is free.
        </p>

        {!ok && (
          <p className="notice warn">
            This link is missing a storefront URL. Ask the seller to send it again, or paste their URL below.
          </p>
        )}

        <AddToClaude name={name || "Sales desk"} url={ok ? url : ""} clientId={clientId} toolName={toolName}
          pendingNote="Paste the seller's storefront URL below to turn this button on." />

        <section className="connect-sec">
          <h2>Have the details instead of a link?</h2>
          <p className="muted small">Paste what the seller sent you and the button above updates.</p>
          <div className="row2">
            <div className="field">
              <label htmlFor="m-url">Remote MCP server URL</label>
              <input id="m-url" className="input mono" type="url" autoComplete="off" spellCheck="false" maxLength={400}
                placeholder="https://org-account.snowflakecomputing.com/api/v2/…"
                value={url} onChange={e => setUrl(e.target.value.trim())} />
            </div>
            <div className="field">
              <label htmlFor="m-cid">OAuth client ID <span className="opt muted">(optional)</span></label>
              <input id="m-cid" className="input mono" type="text" autoComplete="off" spellCheck="false" maxLength={200}
                placeholder="From the seller" value={clientId} onChange={e => setClientId(e.target.value.trim())} />
            </div>
          </div>
          <p className="hint">Never paste a client secret into a web page. Claude asks for it directly if the seller issued one.</p>
        </section>

        <section className="connect-sec">
          <h2>What happens after you connect</h2>
          <p className="muted">
            Give Claude a buying mandate, then let it negotiate. It trades concessions inside your limits and asks
            you before booking anything. The seller's agent never sees your ceiling, and you never see their floor.
          </p>
          <CodeBlock>{MANDATE}</CodeBlock>
          <p className="muted small">Any MCP-capable agent works: claude.ai, Claude Desktop, Claude Code, or your own.</p>
        </section>
      </main>
    </div>
  );
}
