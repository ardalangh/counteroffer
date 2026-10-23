import { Link } from "react-router-dom";

// Two speech bubbles, buyer and seller, meeting over a locked keyhole: they
// negotiate, and the floor stays sealed between them.
export function LogoMark({ size = 28 }) {
  return (
    <img className="logomark" src="/logo-64.png" srcSet="/logo-64.png 1x, /logo-128.png 2x"
      width={size} height={size} alt="" aria-hidden="true" />
  );
}

export default function Logo({ to = "/" }) {
  return (
    <Link className="brand" to={to} aria-label="Counteroffer home">
      <LogoMark />
      Counteroffer
    </Link>
  );
}
