import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  createUserWithEmailAndPassword, GoogleAuthProvider, sendPasswordResetEmail,
  signInWithEmailAndPassword, signInWithPopup
} from "firebase/auth";
import { auth, authMessage } from "../lib/firebase.js";
import { useSession } from "../lib/session.jsx";
import Logo from "../components/Logo.jsx";
import "../styles/login.css";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

export default function Login() {
  const [params] = useSearchParams();
  const [mode, setMode] = useState(params.get("mode") === "signup" ? "signup" : "signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);       // { text, field }
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const { user, ready } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const emailRef = useRef(null), pwRef = useRef(null);
  const up = mode === "signup";
  const dest = (location.state && location.state.from) || "/app";

  useEffect(() => { if (ready && user) navigate(dest, { replace: true }); }, [ready, user, dest, navigate]);
  useEffect(() => { document.title = (up ? "Create your account" : "Sign in") + " · Counteroffer"; }, [up]);

  function fail(text, field) {
    setInfo(""); setError({ text, field });
    if (field === "email") emailRef.current?.focus();
    if (field === "password") pwRef.current?.focus();
  }
  function switchMode() { setMode(up ? "signin" : "signup"); setError(null); setInfo(""); }

  async function onSubmit(e) {
    e.preventDefault();
    if (busy) return;
    setError(null); setInfo("");
    const em = email.trim();
    if (!EMAIL_RE.test(em)) return fail("Enter a valid email address.", "email");
    if (!password) return fail("Enter your password.", "password");
    if (up && password.length < 6) return fail("Use at least 6 characters for your password.", "password");
    setBusy(true);
    try {
      if (up) await createUserWithEmailAndPassword(auth, em, password);
      else await signInWithEmailAndPassword(auth, em, password);
    } catch (err) {
      const c = err.code || "";
      fail(authMessage(err), /password|credential/.test(c) ? "password" : /email|user-not-found/.test(c) ? "email" : null);
    } finally { setBusy(false); }
  }

  async function onGoogle() {
    if (busy) return;
    setError(null); setInfo(""); setBusy(true);
    try { await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch (err) { fail(authMessage(err)); }
    finally { setBusy(false); }
  }

  async function onForgot() {
    if (busy) return;
    setError(null);
    const em = email.trim();
    if (!em) return fail("Enter your email above, then choose Forgot password again.", "email");
    setBusy(true);
    try {
      await sendPasswordResetEmail(auth, em);
      setInfo("If an account exists for " + em + ", a reset link is on its way.");
    } catch (err) { fail(authMessage(err), "email"); }
    finally { setBusy(false); }
  }

  return (
    <div className="login">
      <header className="login-top"><div className="wrap"><Logo /></div></header>
      <main className="login-main" id="main">
        <div className="login-box">
          <h1>{up ? "Create your account" : "Sign in"}</h1>
          <p className="login-sub">
            {up ? "Free to start. Your Snowflake credentials never leave your account."
                : "Welcome back. Pick up where you left off."}
          </p>

          {error && <p className="notice bad" role="alert">{error.text}</p>}
          {info && <p className="notice good" role="status">{info}</p>}

          <button className="btn btn-block google" type="button" onClick={onGoogle} disabled={busy}>
            <GoogleIcon /> Continue with Google
          </button>
          <div className="or"><span>or with email</span></div>

          <form onSubmit={onSubmit} noValidate>
            <div className="field">
              <label htmlFor="email">Work email</label>
              <input ref={emailRef} id="email" className="input" type="email" autoComplete="email" inputMode="email"
                value={email} onChange={e => setEmail(e.target.value)}
                aria-invalid={error && error.field === "email" ? "true" : undefined} />
            </div>
            <div className="field">
              <div className="field-row">
                <label htmlFor="password">Password</label>
                {!up && <button type="button" className="linkbtn small" onClick={onForgot} disabled={busy}>Forgot password?</button>}
              </div>
              <input ref={pwRef} id="password" className="input" type="password"
                autoComplete={up ? "new-password" : "current-password"}
                value={password} onChange={e => setPassword(e.target.value)}
                aria-invalid={error && error.field === "password" ? "true" : undefined} />
              {up && <span className="hint">At least 6 characters.</span>}
            </div>
            <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
              {busy ? "One moment…" : up ? "Create account" : "Sign in"}
            </button>
          </form>

          <p className="login-foot">
            {up ? "Already have an account?" : "New to Counteroffer?"}{" "}
            <button type="button" className="linkbtn" onClick={switchMode}>{up ? "Sign in" : "Create an account"}</button>
          </p>
        </div>
      </main>
    </div>
  );
}
