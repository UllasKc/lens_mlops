import { createApp, genie, server, lakebase } from '@databricks/appkit';
import { buildChatRouter } from './routes/chat.js';
import { buildDashboardRouter } from './routes/dashboard.js';
import { buildExplorerRouter } from './routes/explorer.js';
import { buildEvalsRouter } from './routes/evals.js';
import { buildCostRouter } from './routes/cost.js';
import { startIdleStop, trackUse } from './lib/idleStop.js';

createApp({
  plugins: [
    genie(),
    lakebase(),
    server({ staticPath: 'public' }),
  ],
  onPluginsReady(appkit) {
    startIdleStop();
    appkit.server.extend((app) => {
      app.use(trackUse);   // first, so every request from a signed-in caller counts as use
      // The tabs this deployment shows (deploy config `visible_tabs`; all four when not set). Loaded by the page
      // before its own scripts, so a hidden tab never flashes up. Hiding only: the APIs behind it still answer.
      app.get('/api/ui-config.js', (_req, res) => {
        const all = ['home', 'explorer', 'assistant', 'obs'];
        const wanted = (process.env.LENS_VISIBLE_TABS ?? '').split(',').map((t) => t.trim()).filter((t) => all.includes(t));
        res.type('application/javascript').set('Cache-Control', 'no-store')
          .send(`window.LENS_TABS = ${JSON.stringify(wanted.length ? wanted : all)};`);
      });
      app.use(buildChatRouter(appkit));
      app.use(buildDashboardRouter(appkit.lakebase));
      app.use(buildExplorerRouter(appkit.lakebase));
      app.use(buildEvalsRouter(appkit));
      app.use(buildCostRouter());
    });
  },
}).catch(console.error);
