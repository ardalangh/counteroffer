import { useState } from "react";
import { copyText } from "../lib/copy.js";

export function CopyButton({ text, label = "Copy", className = "copybtn" }) {
  const [state, setState] = useState("idle");
  async function onClick() {
    const ok = await copyText(typeof text === "function" ? text() : text);
    setState(ok ? "ok" : "fail");
    setTimeout(() => setState("idle"), 1600);
  }
  return (
    <button type="button" className={className + (state === "ok" ? " ok" : "")} onClick={onClick}>
      {state === "ok" ? "Copied" : state === "fail" ? "Select and copy" : label}
    </button>
  );
}

export function CodeBlock({ children, wrap = false, label }) {
  const text = String(children);
  return (
    <div className={"codeblock" + (wrap ? " wrap" : "")}>
      <pre aria-label={label}><code>{text}</code></pre>
      <CopyButton text={text} />
    </div>
  );
}

export function Value({ children }) {
  const text = String(children);
  return (
    <div className="value">
      <code>{text}</code>
      <CopyButton text={text} />
    </div>
  );
}
