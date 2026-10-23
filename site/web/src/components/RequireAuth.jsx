import { Navigate, useLocation } from "react-router-dom";
import { useSession } from "../lib/session.jsx";

export default function RequireAuth({ children }) {
  const { user, ready } = useSession();
  const location = useLocation();
  if (!ready) return <div className="loading" role="status">Checking your session…</div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}
