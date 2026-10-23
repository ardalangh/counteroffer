// Escaping for user values placed into generated SQL / MCP YAML.
// Values go inside single-quoted literals or $$ blocks, so $$ is stripped.
function noDollars(s) { while (s.indexOf("$$") !== -1) s = s.replace(/\$\$/g, ""); return s; }
export function sqlStr(v) { return noDollars(String(v == null ? "" : v)).replace(/'/g, "''"); }
export function yamlStr(v) {
  return noDollars(String(v == null ? "" : v)).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ");
}
