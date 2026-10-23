// "Set up by chatting with Claude". Talks to the onboard_chat callable Cloud
// Function (Claude via Snowflake Cortex). Model and user text render as plain
// text; nothing here is ever injected as markup.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../lib/firebase.js";
import { useSession } from "../lib/session.jsx";
import { CodeBlock } from "./Copy.jsx";

const STARTER = "Tell me about your business. What do you sell, and how do deals usually get negotiated?";
const MAX_MSGS = 40, MAX_LEN = 4000;
const onboardChat = httpsCallable(functions, "onboard_chat", { timeout: 540000 });

const PREVIEW_MESSAGES = [
  { role: "user", content: "We're a freight broker. Mostly dry van truckload on West Coast to Texas lanes, 12-month contracts with shippers." },
  { role: "assistant", content: "Got it. How do you usually price a lane? For example, a target margin over carrier cost, and a minimum you won't go below?" }
];

function friendly(err) {
  const code = String((err && err.code) || "");
  const msg = String((err && err.message) || "");
  const ours = msg && !/^(internal|not[- ]found|unavailable)$/i.test(msg);
  if (code === "functions/unauthenticated") return "Sign in again to use AI setup.";
  if (code === "functions/deadline-exceeded") return "That took too long. Try again; generating the files can take a couple of minutes.";
  if (ours && /functions\/(resource-exhausted|invalid-argument|unavailable|internal)/.test(code)) return msg;
  return "AI setup isn't available right now. You can use the steps below instead.";
}

function readCollapsed() {
  try { return localStorage.getItem("aiPanelCollapsed") === "1"; } catch { return false; }
}

export default function OnboardChat({ onSpec }) {
  const { user, preview } = useSession();
  const uid = user && user.uid;
  const [messages, setMessages] = useState(preview ? PREVIEW_MESSAGES : []);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [open, setOpen] = useState(() => !readCollapsed());
  const logRef = useRef(null);
  const inputRef = useRef(null);

  // Load the saved conversation.
  useEffect(() => {
    if (!uid || preview) return;
    let live = true;
    getDoc(doc(db, "workspaces", uid)).then(snap => {
      const c = snap.exists() && snap.data().onboardingChat;
      if (!live || !c || !Array.isArray(c.messages)) return;
      setMessages(c.messages.filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string").slice(-MAX_MSGS));
      setResult(c.result && c.result.spec ? c.result : null);
    }).catch(e => console.warn("Couldn't load the onboarding chat", e.code || e));
    return () => { live = false; };
  }, [uid, preview]);

  useEffect(() => {
    try { localStorage.setItem("aiPanelCollapsed", open ? "0" : "1"); } catch { /* private mode */ }
  }, [open]);

  // Keep the newest message in view.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy, open]);

  // Grow the composer with its content, up to a limit.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 180) + "px";
  }, [text, open]);

  async function persist(nextMessages, nextResult) {
    if (!uid || preview) return;
    try {
      await setDoc(doc(db, "workspaces", uid), {
        onboardingChat: { messages: nextMessages, result: nextResult || null, updatedAt: serverTimestamp() }
      }, { merge: true });
    } catch (e) { console.warn("Couldn't save the onboarding chat", e.code || e); }
  }

  async function send() {
    const t = text.trim();
    if (busy || !t) return;
    if (t.length > MAX_LEN) { setError("Keep each message under 4,000 characters."); return; }
    if (messages.length + 1 > MAX_MSGS) { setError("This conversation is at its limit. Start over, or use the steps below."); return; }
    if (preview) { setError("Preview mode: replies are turned off. Sign in for real to chat with Claude."); return; }

    setError("");
    const withUser = [...messages, { role: "user", content: t }];
    setMessages(withUser);
    setText("");
    setBusy(true);
    persist(withUser, result);
    try {
      const res = await onboardChat({ messages: withUser.slice(-MAX_MSGS) });
      const d = res.data || {};
      const withReply = [...withUser, { role: "assistant", content: String(d.reply || "") }];
      let nextResult = result;
      if (d.done && d.spec) {
        nextResult = { spec: d.spec, files: d.files || {}, validation: d.validation || {}, repairs: Number(d.repairs) || 0 };
        onSpec && onSpec(d.spec);
      }
      setMessages(withReply);
      setResult(nextResult);
      persist(withReply, nextResult);
    } catch (e) {
      console.warn("onboard_chat failed", e.code || e);
      setMessages(messages);          // let the seller retry the same message
      setText(t);
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  }

  function startOver() {
    if (busy) return;
    if (messages.length && !window.confirm("Clear this conversation with Claude?")) return;
    setMessages([]); setResult(null); setError("");
    persist([], null);
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
  }

  return (
    <section className="sheet chat" aria-labelledby="chat-h">
      <div className="chat-head">
        <div className="chat-title">
          <h2 id="chat-h">Set up by chatting with Claude</h2>
          <p>
            Describe your business and Claude drafts your pricing rules, data, agent and MCP setup, then checks the
            SQL in a Snowflake sandbox that's rolled back. Nothing is deployed to your account.
          </p>
        </div>
        <button type="button" className="btn btn-sm" aria-expanded={open} aria-controls="chat-body" onClick={() => setOpen(o => !o)}>
          {open ? "Hide" : messages.length ? "Continue" : "Start"}
        </button>
      </div>

      {open && (
        <div id="chat-body">
          <div className="chat-log" ref={logRef} role="log" aria-live="polite">
            <Bubble role="assistant">{STARTER}</Bubble>
            {messages.map((m, i) => <Bubble key={i} role={m.role}>{m.content}</Bubble>)}
            {busy && (
              <div className="bubble assistant" aria-label="Claude is writing">
                <span className="typing" aria-hidden="true"><i /><i /><i /></span>
              </div>
            )}
          </div>

          {error && <p className="notice bad chat-err" role="alert">{error}</p>}

          <form className="composer" onSubmit={e => { e.preventDefault(); send(); }}>
            <label className="sr-only" htmlFor="chat-input">Message Claude</label>
            <textarea id="chat-input" ref={inputRef} rows={1} maxLength={MAX_LEN} disabled={busy}
              placeholder="Reply to Claude…" value={text} onChange={e => setText(e.target.value)} onKeyDown={onKeyDown} />
            <button type="submit" className="send" disabled={busy || !text.trim()} aria-label="Send">
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15.5V4.5M10 4.5 5.5 9M10 4.5 14.5 9" /></svg>
            </button>
          </form>
          <div className="chat-foot">
            <span>{busy ? "Claude is writing…" : "Enter to send, Shift and Enter for a new line"}</span>
            {messages.length > 0 && <button type="button" className="linkbtn" onClick={startOver} disabled={busy}>Start over</button>}
          </div>

          {result && result.spec && <ChatResult result={result} />}
        </div>
      )}
    </section>
  );
}

function Bubble({ role, children }) {
  return (
    <div className={"bubble " + role}>
      <span className="who">{role === "user" ? "You" : "Claude"}</span>
      <span className="text">{children}</span>
    </div>
  );
}

function ChatResult({ result }) {
  const s = result.spec, files = result.files || {}, val = result.validation || {};
  return (
    <div className="chat-result">
      <h3>Draft for {String(s.company_name || "your company")}</h3>
      <dl className="kv">
        <div><dt>Industry</dt><dd>{String(s.industry || "—")}</dd></div>
        <div><dt>Ready to deploy</dt><dd>{s.deployable ? "Yes, it runs on the current freight engine" : "Not yet, it needs an engine extension (spec only)"}</dd></div>
        {s.agent_name && <div><dt>Sales agent</dt><dd>{String(s.agent_name)}</dd></div>}
        {result.repairs > 0 && <div><dt>Self-repair</dt><dd>Claude fixed its own SQL {result.repairs} time{result.repairs === 1 ? "" : "s"} after sandbox errors</dd></div>}
      </dl>
      {Object.entries(files).map(([name, sql]) => {
        const ok = val[name] === "OK";
        return (
          <div className="chat-file" key={name}>
            <div className="chat-file-head">
              <span className="mono">{name}</span>
              <span className={"status " + (ok ? "green" : "red")}>{ok ? "Checked in the Snowflake sandbox" : "Error"}</span>
            </div>
            {!ok && val[name] && <p className="error">{String(val[name])}</p>}
            <CodeBlock>{String(sql)}</CodeBlock>
          </div>
        );
      })}
      <p className="hint">The steps below have been filled in from this draft. The check ran inside a rolled-back sandbox transaction; nothing was deployed.</p>
    </div>
  );
}
