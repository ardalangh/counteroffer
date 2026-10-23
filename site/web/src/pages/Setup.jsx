import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "../lib/firebase.js";
import { useSession } from "../lib/session.jsx";
import {
  FILES, RAW, STEPS, TIERS, TIER_NAMES, LEVERS, LEVER_LABELS, INDUSTRIES, EXAMPLE_COST,
  defaults, mergeLoaded, persistable, accountValid, host, storefrontUrl, companyName, deskName, slug,
  shareLink, validatePolicy, floorPreview, prereqSql, policySql, OAUTH_SQL, mcpSql, inviteText, applySpec
} from "../lib/setup.js";
import { CodeBlock, Value } from "../components/Copy.jsx";
import AddToClaude from "../components/AddToClaude.jsx";
import OnboardChat from "../components/OnboardChat.jsx";
import "../styles/setup.css";
import "../styles/chat.css";

const SAVE_DELAY = 800;

function stepFromHash() {
  const m = /^#step-([1-6])$/.exec(window.location.hash);
  return m ? Number(m[1]) : null;
}

export default function Setup() {
  const { user, preview } = useSession();
  const uid = user && user.uid;
  const [state, setState] = useState(defaults);
  const [loaded, setLoaded] = useState(false);
  const [save, setSave] = useState({ text: "", tone: "" });
  const [step, setStep] = useState(() => stepFromHash() || 1);
  const dirty = useRef(false);
  const timer = useRef(null);
  const latest = useRef(state);
  latest.current = state;

  useEffect(() => { document.title = "Setup · Counteroffer"; }, []);

  // ---------- load ----------
  useEffect(() => {
    if (!uid) return;
    if (preview) { setLoaded(true); setSave({ text: "Preview, not saved", tone: "" }); return; }
    let live = true;
    getDoc(doc(db, "workspaces", uid)).then(snap => {
      if (!live) return;
      const s = snap.exists() ? mergeLoaded(snap.data()) : defaults();
      setState(s);
      if (!stepFromHash()) {
        const firstOpen = STEPS.find(x => !s.done[x.key]);
        setStep(firstOpen ? firstOpen.key : 6);
      }
      setSave({ text: snap.exists() ? "Saved" : "", tone: "ok" });
    }).catch(e => {
      console.error(e);
      setSave({ text: "Couldn't load your saved progress (" + (e.code || "error") + ")", tone: "bad" });
    }).finally(() => live && setLoaded(true));
    return () => { live = false; };
  }, [uid, preview]);

  // ---------- save ----------
  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    if (!uid || preview || !dirty.current) return;
    dirty.current = false;
    setSave({ text: "Saving…", tone: "" });
    try {
      await setDoc(doc(db, "workspaces", uid), { ...persistable(latest.current), updatedAt: serverTimestamp() }, { merge: true });
      setSave({ text: "Saved", tone: "ok" });
    } catch (e) {
      dirty.current = true;
      console.error(e);
      setSave({ text: "Couldn't save (" + (e.code || "error") + "). Retrying…", tone: "bad" });
      timer.current = setTimeout(flush, 4000);
    }
  }, [uid, preview]);

  useEffect(() => {
    const onHide = () => { if (document.visibilityState === "hidden") flush(); };
    document.addEventListener("visibilitychange", onHide);
    return () => { document.removeEventListener("visibilitychange", onHide); flush(); };
  }, [flush]);

  const update = useCallback(fn => {
    setState(prev => fn(JSON.parse(JSON.stringify(prev))));
    if (preview) return;
    dirty.current = true;
    setSave({ text: "Unsaved changes", tone: "" });
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DELAY);
  }, [flush, preview]);

  const set = (key, value) => update(s => { s[key] = value; return s; });

  // ---------- steps ----------
  function goTo(n) {
    setStep(n);
    window.history.replaceState(null, "", "#step-" + n);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function markDone(n, value) {
    update(s => { s.done[n] = value; return s; });
  }

  const doneCount = STEPS.filter(x => state.done[x.key]).length;
  const allDone = doneCount === 6;

  if (!loaded) return <div className="loading" role="status">Loading your workspace…</div>;

  return (
    <div className="wrap page setup">
      <div className="pagehead setup-head">
        <div>
          <h1>Set up your storefront</h1>
          <p>Everything runs in your own Snowflake account, under your admin. Your progress saves as you go.</p>
        </div>
        <span className={"savestate " + save.tone} aria-live="polite">{save.text}</span>
      </div>

      {allDone && (
        <div className="live" role="status">
          <div>
            <h2>Your storefront is live</h2>
            <p>Buyers' AI agents can now negotiate with {companyName(state)}. Your agent never sees the floor.</p>
          </div>
          <Link className="btn btn-primary" to="/console">Open the monitor</Link>
        </div>
      )}

      <OnboardChat onSpec={spec => update(s => applySpec(s, spec))} />

      <div className="stepper">
        <nav className="steplist" aria-label="Setup steps">
          <ol>
            {STEPS.map(x => {
              const done = !!state.done[x.key];
              return (
                <li key={x.key}>
                  <button type="button" onClick={() => goTo(x.key)} aria-current={step === x.key ? "step" : undefined}
                    className={(step === x.key ? "current " : "") + (done ? "done" : "")}>
                    <span className="dot" aria-hidden="true">{done ? <Check /> : x.key}</span>
                    <span className="names"><b>{x.name}</b><span>{x.blurb}</span></span>
                    <span className="sr-only">{done ? " (done)" : ""}</span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="progress" aria-label={doneCount + " of 6 steps done"}>
            <div className="bar"><i style={{ width: (doneCount / 6) * 100 + "%" }} /></div>
            <span>{doneCount} of 6 done</span>
          </div>
        </nav>

        <section className="sheet stepbody" aria-labelledby="step-h">
          <div className="sheet-body">
            <p className="stepno">Step {step} of 6</p>
            <StepContent step={step} state={state} set={set} update={update} />
          </div>
          <div className="stepnav">
            <button type="button" className="btn btn-quiet" onClick={() => goTo(step - 1)} disabled={step === 1}>Back</button>
            <span className="grow" />
            {state.done[step]
              ? <button type="button" className="linkbtn small" onClick={() => markDone(step, false)}>Mark as not done</button>
              : null}
            {step < 6 ? (
              <button type="button" className="btn btn-primary" onClick={() => { if (!state.done[step]) markDone(step, true); goTo(step + 1); }}>
                {state.done[step] ? "Continue" : "Done, continue"}
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={() => markDone(6, true)} disabled={!!state.done[6]}>
                {state.done[6] ? "All done" : "Finish setup"}
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function Check() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 4.5" /></svg>;
}

function StepContent({ step, state, set, update }) {
  switch (step) {
    case 1: return <StepWorkspace state={state} set={set} />;
    case 2: return <StepPrereqs state={state} />;
    case 3: return <StepInstall />;
    case 4: return <StepPricing state={state} update={update} />;
    case 5: return <StepPublish state={state} set={set} />;
    default: return <StepInvite state={state} />;
  }
}

function StepWorkspace({ state, set }) {
  const acct = state.account.trim();
  const bad = acct !== "" && !accountValid(state);
  return (
    <>
      <h2 id="step-h">Your workspace</h2>
      <p className="lead">Tell us who you are and which Snowflake account your storefront runs in.</p>
      <div className="row2">
        <div className="field">
          <label htmlFor="company">Company name</label>
          <input id="company" className="input" type="text" autoComplete="organization" maxLength={80}
            placeholder="Acme Freight Co." value={state.company} onChange={e => set("company", e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="industry">Industry</label>
          <select id="industry" className="select" value={state.industry} onChange={e => set("industry", e.target.value)}>
            {INDUSTRIES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="account">Snowflake account identifier</label>
        <input id="account" className="input mono" type="text" autoComplete="off" autoCapitalize="characters" spellCheck="false"
          maxLength={120} placeholder="ORGNAME-ACCOUNTNAME" value={state.account}
          onChange={e => set("account", e.target.value)} aria-invalid={bad ? "true" : undefined}
          aria-describedby="account-hint" />
        {bad
          ? <p className="error">Use ORGNAME-ACCOUNTNAME: letters, digits and underscores, with exactly one hyphen. For example ACMEORG-FREIGHT_PROD.</p>
          : <span className="hint" id="account-hint">In Snowsight, click your name in the bottom left, then Connect a tool to Snowflake.</span>}
      </div>
      <div className="derived">
        <span className="muted small">Your storefront will be at</span>
        <code className={accountValid(state) ? "" : "muted"}>{host(state)}</code>
      </div>
    </>
  );
}

function StepPrereqs({ state }) {
  return (
    <>
      <h2 id="step-h">Turn on Claude in Cortex</h2>
      <p className="lead">
        You need <code>ACCOUNTADMIN</code> for setup, and Claude models on Cortex need cross-region inference.
        Run this in a Snowsight worksheet.
      </p>
      <CodeBlock>{prereqSql(state)}</CodeBlock>
      <p className="muted">If it answers <code>pong</code>, Claude is reachable from your account.</p>
    </>
  );
}

function StepInstall() {
  return (
    <>
      <h2 id="step-h">Install Counteroffer</h2>
      <p className="lead">Run these files in order in a Snowsight worksheet. Open each one, copy it in, and run it all.</p>
      <ol className="files">
        {FILES.map(([f, purpose]) => (
          <li key={f}>
            <a className="mono" href={RAW + f} target="_blank" rel="noopener noreferrer">sql/{f}</a>
            <span>{purpose}</span>
          </li>
        ))}
      </ol>
      <p className="notice warn"><code>02_seed.sql</code> loads demo data. Skip or replace it when you're loading your own lanes, costs and customers.</p>
    </>
  );
}

function NumberCell({ id, value, invalid, onChange, step = "0.5", min = "0", max, suffix, label }) {
  return (
    <div className={"numcell" + (suffix ? " has-suffix" : "")}>
      <input id={id} className="input mono" type="number" inputMode="decimal" step={step} min={min} max={max}
        value={value} aria-label={label} aria-invalid={invalid ? "true" : undefined}
        onChange={e => onChange(e.target.value === "" ? "" : Number(e.target.value))} />
      {suffix && <span className="suffix" aria-hidden="true">{suffix}</span>}
    </div>
  );
}

function StepPricing({ state, update }) {
  const { errors, invalid } = useMemo(() => validatePolicy(state), [state]);
  const preview = useMemo(() => floorPreview(state), [state]);
  const tiers = Object.keys(TIERS);
  const rows = [
    ["target", "Target margin", "List price is cost plus this", "%"],
    ["min", "Minimum margin", "The floor before concessions", "%"],
    ["absmin", "Absolute minimum", "The floor never goes below this", "%"],
    ["threshold", "Approval above", "Contracts bigger than this wait for you", "$"]
  ];
  const setTier = (t, k, v) => update(s => { s.tiers[t][k] = v; return s; });
  const setLever = (k, v) => update(s => { s.levers[k] = v; return s; });

  return (
    <>
      <h2 id="step-h">Set your pricing rules</h2>
      <p className="lead">
        These live in <code>COUNTEROFFER.PRIVATE</code>, which your sales agent can't read. Changing them later is
        an <code>UPDATE</code>, not a redeploy.
      </p>

      <h3 className="subh">Margins by customer tier</h3>
      <div className="table-scroll">
        <table className="ptable">
          <thead>
            <tr><th scope="col"><span className="sr-only">Setting</span></th>{tiers.map(t => <th key={t} scope="col">{TIER_NAMES[t]}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map(([k, label, hint, unit]) => (
              <tr key={k}>
                <th scope="row"><b>{label}</b><span>{hint}</span></th>
                {tiers.map(t => (
                  <td key={t}>
                    <NumberCell id={`t-${t}-${k}`} value={state.tiers[t][k]} invalid={invalid.has(`t-${t}-${k}`)}
                      label={`${TIER_NAMES[t]} ${label.toLowerCase()}`}
                      step={k === "threshold" ? "1000" : "0.5"} max={k === "threshold" ? undefined : "100"}
                      suffix={unit === "%" ? "%" : null}
                      onChange={v => setTier(t, k, v)} />
                  </td>
                ))}
              </tr>
            ))}
            <tr className="ro">
              <th scope="row"><b>Counter buffer · max rounds</b><span>Fixed per tier</span></th>
              {tiers.map(t => <td key={t} className="mono muted">{TIERS[t].buffer}% · {TIERS[t].rounds}</td>)}
            </tr>
          </tbody>
        </table>
      </div>

      <h3 className="subh">What each concession is worth</h3>
      <p className="muted small" style={{ marginTop: -6 }}>Margin points taken off the minimum when a buyer offers it. Negative means it costs you.</p>
      <div className="levers">
        {Object.keys(LEVERS).map(k => (
          <div className="field" key={k}>
            <label htmlFor={`l-${k}`}>{LEVER_LABELS[k]}</label>
            <NumberCell id={`l-${k}`} value={state.levers[k]} invalid={invalid.has(`l-${k}`)} min="-50" max="50"
              suffix="pts" label={LEVER_LABELS[k]} onChange={v => setLever(k, v)} />
          </div>
        ))}
      </div>

      {errors.length > 0 && (
        <div className="notice bad" role="alert">
          <ul className="errlist">{errors.map(e => <li key={e}>{e}</li>)}</ul>
        </div>
      )}

      <h3 className="subh">Preview on an example load</h3>
      <p className="muted small" style={{ marginTop: -6 }}>Carrier cost {"$" + EXAMPLE_COST.toLocaleString("en-US")} per load.</p>
      <div className="table-scroll">
        <table className="previewtable">
          <thead><tr><th scope="col">Tier</th><th scope="col">List price</th><th scope="col">Floor</th><th scope="col">Floor with every concession</th></tr></thead>
          <tbody>
            {preview.map(r => (
              <tr key={r.tier}><td>{r.tier}</td><td className="mono">{r.list}</td><td className="mono">{r.floor}</td><td className="mono">{r.levered}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="subh">Run this to apply them</h3>
      <CodeBlock>{policySql(state)}</CodeBlock>
    </>
  );
}

function StepPublish({ state, set }) {
  return (
    <>
      <h2 id="step-h">Publish your storefront</h2>
      <p className="notice good">
        <b>Counteroffer never stores your Snowflake credentials.</b> Everything runs in your account under your admin.
        Don't paste a client secret, password or token here.
      </p>

      <h3 className="subh">1. Create the sign-in buyers use</h3>
      <CodeBlock>{OAUTH_SQL}</CodeBlock>

      <h3 className="subh">2. Publish the MCP server in front of your sales agent</h3>
      <CodeBlock>{mcpSql(state)}</CodeBlock>

      <h3 className="subh">Your storefront URL</h3>
      <Value>{storefrontUrl(state)}</Value>

      <div className="field" style={{ marginTop: 20 }}>
        <label htmlFor="clientid">OAuth client ID <span className="opt muted">(optional)</span></label>
        <input id="clientid" className="input mono" type="text" autoComplete="off" spellCheck="false" maxLength={200}
          placeholder="OAUTH_CLIENT_ID from the query above" value={state.clientId} onChange={e => set("clientId", e.target.value)} />
        <span className="hint">Just the client ID. It's an identifier and safe to share with buyers. Never the client secret.</span>
      </div>
    </>
  );
}

function StepInvite({ state }) {
  const link = shareLink(state);
  return (
    <>
      <h2 id="step-h">Invite your buyers</h2>
      <p className="lead">Send buyers one link. It opens a page with an Add to Claude button that connects their agent to your storefront.</p>

      <Value>{link}</Value>
      <p><a href={link} target="_blank" rel="noopener noreferrer">Open the buyer page</a></p>

      <h3 className="subh">What buyers see</h3>
      <AddToClaude name={deskName(state)} url={storefrontUrl(state)} clientId={state.clientId} toolName={slug(state)}
        pendingNote="Fill in your Snowflake account in step 1 and this button goes live." />

      <h3 className="subh">Invite message</h3>
      <CodeBlock wrap>{inviteText(state)}</CodeBlock>

      <h3 className="subh">Watch and approve</h3>
      <p className="muted">
        The monitor shows every move your agent and your buyers' agents make, flags injection attempts, and holds
        anything over your approval limit for you. It shows a worked example until you connect the bridge.
      </p>
      <p><Link className="btn" to="/console">Open the monitor</Link></p>
    </>
  );
}
