import { appkitServerConfig } from '@databricks/appkit/tsdown';

// AppKit's server build preset. When you keep code agents in `server/agents/`,
// it auto-includes them as build entries so discovery works in a bundled build.
// Customize with overrides — `appkitServerConfig({ external, define, ... })` —
// or a function form for full control: `appkitServerConfig((base) => ({ ...base }))`.
//
// `unbundle: true` means tsdown emits one output file per source file rather
// than inlining the whole graph — but it only auto-discovers `server/agents/`.
// Plain relative-import files elsewhere (routes/, lib/) are silently left as
// unresolved `.ts` import specifiers in the compiled output otherwise (a
// runtime-broken `dist/server.js` that "builds" successfully) unless listed
// here explicitly.
export default appkitServerConfig({
  entry: ['server/routes/*.ts', 'server/lib/*.ts'],
});
