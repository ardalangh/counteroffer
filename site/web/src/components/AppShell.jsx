import { useEffect, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import { auth } from "../lib/firebase.js";
import { useSession } from "../lib/session.jsx";
import Logo from "./Logo.jsx";

function AccountMenu() {
  const { user, preview } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const navigate = useNavigate();
  const email = (user && (user.email || user.displayName)) || "Signed in";

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = e => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  async function onSignOut() {
    setOpen(false);
    if (!preview) await signOut(auth);
    navigate("/login", { replace: true });
  }

  return (
    <div className="account" ref={ref}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span className="avatar" aria-hidden="true">{email.slice(0, 1).toUpperCase()}</span>
        <span className="email">{email}</span>
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="who"><b>Signed in</b>{email}</div>
          <button type="button" role="menuitem" onClick={onSignOut}>Sign out</button>
        </div>
      )}
    </div>
  );
}

export default function AppShell({ children }) {
  const cls = ({ isActive }) => (isActive ? "active" : "");
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="topbar">
        <div className="wrap">
          <Logo />
          <nav className="tabs" aria-label="Main">
            <NavLink to="/console" className={cls}>Monitor</NavLink>
            <NavLink to="/app" className={cls}>Setup</NavLink>
          </nav>
          <span className="spacer" />
          <AccountMenu />
        </div>
      </header>
      <main id="main">{children}</main>
    </>
  );
}
