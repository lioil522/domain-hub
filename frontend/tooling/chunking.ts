/** Only dependencies receive framework names; application/lazy code never does. */
export function dependencyChunkName(moduleId: string): string | null {
  const id = moduleId.replace(/\\/g, "/");
  if (!id.includes("/node_modules/")) return null;
  if (id.includes("/node_modules/lucide-react/")) return "icons";
  if (/\/node_modules\/(?:react|react-dom|scheduler|qrcode\.react)\//.test(id)) return "react-vendor";
  return "vendor";
}
