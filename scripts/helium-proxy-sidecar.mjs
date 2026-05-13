// Helium proxy sidecar — boots the v1-fork's `helium-api` module as a
// standalone service on port 9224.
//
// Why: the proxy provided per-tab gating + 1Password credential pipeline +
// Slack send-file endpoint, all baked into the v1 host process. v2's host
// doesn't include them. Rather than port ~930 lines into v2 right now, we
// reuse the v1 compiled module verbatim. The v1 working tree stays
// read-only — this script never writes into it.
//
// To rebuild v1 without breaking this, leave `/Users/joel/nanoclaw/dist/`
// in place; this script reads compiled JS only.

import('/Users/joel/nanoclaw/dist/helium-api.js')
  .then((mod) => {
    if (typeof mod.startHeliumApi !== 'function') {
      throw new Error('startHeliumApi not exported by v1 helium-api dist');
    }
    const server = mod.startHeliumApi();
    const port = mod.HELIUM_API_PORT ?? 9224;
    console.log(`[helium-proxy-sidecar] started on port ${port}`);

    const shutdown = (sig) => {
      console.log(`[helium-proxy-sidecar] ${sig} — closing`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 5000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  })
  .catch((err) => {
    console.error('[helium-proxy-sidecar] failed to start:', err);
    process.exit(1);
  });
