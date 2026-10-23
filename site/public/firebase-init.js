// Shared Firebase setup + helpers for login.html and app.html.
// The web config below is public by design (it identifies the project; access is enforced by Auth + Firestore rules).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCtlPD0wd7bCeq0HYzqXnCY404Bm2aYzpo",
  authDomain: "counteroffer-storefront.firebaseapp.com",
  projectId: "counteroffer-storefront",
  storageBucket: "counteroffer-storefront.firebasestorage.app",
  messagingSenderId: "781632534088",
  appId: "1:781632534088:web:83c34188fcd03080c54a7d"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Firebase Hosting has cleanUrls (/login); a plain static server needs login.html.
const CLEAN = /\.(web\.app|firebaseapp\.com)$/.test(location.hostname);
export function pageUrl(name) {
  if (name === "home") return CLEAN ? "/" : "index.html";
  return CLEAN ? "/" + name : name + ".html";
}
export function go(name) { location.replace(pageUrl(name)); }

// Plain-English auth errors.
const AUTH_ERRORS = {
  "auth/invalid-email": "That email address doesn't look right.",
  "auth/missing-email": "Enter your email address.",
  "auth/missing-password": "Enter your password.",
  "auth/user-not-found": "No account with that email. Create one instead?",
  "auth/wrong-password": "Wrong email or password.",
  "auth/invalid-credential": "Wrong email or password.",
  "auth/invalid-login-credentials": "Wrong email or password.",
  "auth/email-already-in-use": "An account with that email already exists. Sign in instead.",
  "auth/weak-password": "Password is too weak. Use at least 6 characters.",
  "auth/too-many-requests": "Too many attempts. Wait a minute and try again.",
  "auth/network-request-failed": "Network error. Check your connection and try again.",
  "auth/popup-closed-by-user": "The Google sign-in window was closed before finishing.",
  "auth/cancelled-popup-request": "The Google sign-in window was closed before finishing.",
  "auth/popup-blocked": "Your browser blocked the Google popup. Allow popups for this site and retry.",
  "auth/unauthorized-domain": "This domain isn't authorized for sign-in yet. Use counteroffer-storefront.web.app.",
  "auth/operation-not-allowed": "That sign-in method isn't enabled.",
  "auth/user-disabled": "This account has been disabled."
};
export function authMessage(err) {
  const code = err && err.code;
  return AUTH_ERRORS[code] || "Something went wrong" + (code ? " (" + code + ")" : "") + ". Please try again.";
}

// SQL escaping for user values placed inside single-quoted literals or $$ blocks.
function noDollars(s) { while (s.indexOf("$$") !== -1) s = s.replace(/\$\$/g, ""); return s; }
export function sqlStr(v) { return noDollars(String(v == null ? "" : v)).replace(/'/g, "''"); }
// For values inside double-quoted YAML strings in the MCP spec.
export function yamlStr(v) { return noDollars(String(v == null ? "" : v)).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " "); }

// Copy buttons for pre.code blocks (same pattern as the landing page).
export function addCopyButton(pre) {
  if (pre.parentNode && pre.parentNode.classList && pre.parentNode.classList.contains("codewrap")) return;
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "copy"; btn.textContent = "Copy";
  btn.setAttribute("aria-label", "Copy to clipboard");
  btn.addEventListener("click", () => copyText(pre.querySelector("code") ? pre.querySelector("code").textContent : pre.textContent, btn));
  const wrap = document.createElement("div");
  wrap.className = "codewrap";
  pre.parentNode.insertBefore(wrap, pre);
  wrap.appendChild(pre); wrap.appendChild(btn);
}
export function copyText(text, btn) {
  const label = btn.textContent;
  const done = () => { btn.textContent = "Copied"; btn.classList.add("ok"); setTimeout(() => { btn.textContent = label; btn.classList.remove("ok"); }, 1600); };
  const fallback = () => {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { btn.textContent = "Select & copy"; }
    document.body.removeChild(ta);
  };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
}
