// Who is signed in, app-wide.
//
// Preview mode (local dev only): /app?preview=1 or /console?preview=1 renders
// the signed-in pages with a stand-in user and demo data, so the layout can be
// reviewed without a real sign-in. It is gated on import.meta.env.DEV, which
// Vite replaces with `false` in production builds, so this branch is removed
// from the deployed bundle entirely.
import { createContext, useContext, useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "./firebase.js";

const SessionContext = createContext({ user: null, ready: false, preview: false });

export const PREVIEW = import.meta.env.DEV &&
  new URLSearchParams(window.location.search).get("preview") === "1";

const PREVIEW_USER = { uid: "preview", email: "ops@acmefreight.example", displayName: "Preview" };

export function SessionProvider({ children }) {
  const [state, setState] = useState(
    PREVIEW ? { user: PREVIEW_USER, ready: true, preview: true } : { user: null, ready: false, preview: false });

  useEffect(() => {
    if (PREVIEW) return undefined;
    return onAuthStateChanged(auth, user => setState({ user, ready: true, preview: false }));
  }, []);

  return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);
