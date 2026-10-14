import express from 'express';
import { runSql } from '../lib/sql.js';

/**
 * What this workspace has cost on Databricks since its first day, by service, from
 * gold.qry_platform_cost: the billing system tables (system.billing.usage priced with
 * system.billing.list_prices, at the price in force when used), for this workspace only.
 * The deploy creates that view; it runs with its owner's access, so the app needs no grant
 * on the system catalog. The figures are the whole workspace's: where other projects share the
 * workspace, their usage is included. Figures are list prices, before any discount or commitment.
 *
 * Billing data arrives a few hours late, so results are kept for 30 minutes.
 */

const GOLD = process.env.LENS_GOLD_SCHEMA ?? 'cnx_automl_dev.lens_mlops_gold';
const VIEW = `${GOLD}.qry_platform_cost`;
const TTL_MS = 30 * 60 * 1000;
let cached: { at: number; body: unknown } | null = null;

export function buildCostRouter(): express.Router {
  const router = express.Router();

  router.get('/api/cost', async (req, res): Promise<void> => {
    if (cached && Date.now() - cached.at < TTL_MS && req.query.refresh !== '1') { res.json(cached.body); return; }
    try {
      const [daily, skus, [meta]] = await Promise.all([
        runSql(`SELECT usage_date AS day, product, SUM(cost) AS cost FROM ${VIEW} GROUP BY 1, 2 ORDER BY 1, 2`),
        runSql(`
          SELECT sku, product, unit, SUM(quantity) AS quantity, SUM(cost) AS cost
          FROM ${VIEW} GROUP BY 1, 2, 3 ORDER BY cost DESC LIMIT 12`),
        runSql(`
          SELECT MIN(usage_date) AS first_day, MAX(usage_date) AS last_day,
                 MAX(currency) AS currency, MAX(data_through) AS data_through
          FROM ${VIEW}`),
      ]);
      const body = {
        available: true, ...meta,
        daily: daily.map((r) => ({ day: r.day, product: r.product, cost: Number(r.cost ?? 0) })),
        skus: skus.map((r) => ({ ...r, quantity: Number(r.quantity ?? 0), cost: Number(r.cost ?? 0) })),
      };
      cached = { at: Date.now(), body };
      res.json(body);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // A missing view or no access to billing is a setup step, not an error in the app.
      const setup = /PERMISSION_DENIED|INSUFFICIENT_PERMISSIONS|does not have|TABLE_OR_VIEW_NOT_FOUND|not found/i.test(message);
      res.json({ available: false, reason: setup ? 'access' : 'error', message: setup ? undefined : message });
    }
  });

  return router;
}
