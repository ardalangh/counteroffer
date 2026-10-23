import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/ui.css";
import "./styles/atc.css";

import { SessionProvider } from "./lib/session.jsx";
import RequireAuth from "./components/RequireAuth.jsx";
import AppShell from "./components/AppShell.jsx";
import Landing from "./pages/Landing.jsx";
import Login from "./pages/Login.jsx";

// Signed-in pages load on demand, so the landing page stays light.
const Setup = lazy(() => import("./pages/Setup.jsx"));
const Console = lazy(() => import("./pages/Console.jsx"));
const Connect = lazy(() => import("./pages/Connect.jsx"));

const Loading = () => <div className="loading" role="status">Loading…</div>;

function Private({ children }) {
  return (
    <RequireAuth>
      <AppShell>
        <Suspense fallback={<Loading />}>{children}</Suspense>
      </AppShell>
    </RequireAuth>
  );
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <SessionProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/connect" element={<Suspense fallback={<Loading />}><Connect /></Suspense>} />
          <Route path="/app" element={<Private><Setup /></Private>} />
          <Route path="/console" element={<Private><Console /></Private>} />
          {/* Old static-site URLs keep working. */}
          <Route path="/index.html" element={<Navigate to="/" replace />} />
          <Route path="/login.html" element={<Navigate to="/login" replace />} />
          <Route path="/app.html" element={<Navigate to="/app" replace />} />
          <Route path="/console.html" element={<Navigate to="/console" replace />} />
          <Route path="/connect.html" element={<RedirectKeepQuery to="/connect" />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </SessionProvider>
  </StrictMode>
);

function RedirectKeepQuery({ to }) {
  return <Navigate to={to + window.location.search} replace />;
}

function NotFound() {
  return (
    <div className="wrap page">
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>Page not found</h1>
      <p className="muted">That address doesn't exist. <a href="/">Go to the home page</a>.</p>
    </div>
  );
}
