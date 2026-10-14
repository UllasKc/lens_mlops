import express from 'express';
import { runSql } from '../lib/sql.js';

/**
 * What this project has cost on Databricks since its first day, by service, from
 * gold.qry_platform_cost: the billing system tables (system.billing.usage priced with
 * system.billing.list_prices, at the price in force when used). Each row carries the share
 * that is this project's: 1 for its own app and Genie space, 0 for other projects in the
 * workspace, and for shared services (warehouse, Lakebase, model serving) its share of that
 * day's warehouse query time. shared_share is the cost-weighted share over the whole period. The deploy creates that view; it runs with its owner's access, so
 * the app needs no grant on the system catalog. Figures are list prices, before discounts.
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
      const MINE = `scope <> 'other'`;
      const [daily, services, skus, [meta]] = await Promise.all([
        runSql(`SELECT usage_date AS day, product, SUM(cost * project_share) AS cost FROM ${VIEW} WHERE ${MINE} GROUP BY 1, 2 ORDER BY 1, 2`),
        // Per service: this project's cost, whether it is shared (and the share counted), and
        // how much of its usage was free (Genie's free allowance has no list price).
        runSql(`
          SELECT product, SUM(cost * project_share) AS cost,
                 SUM(CASE WHEN scope = 'shared' THEN cost * project_share END) / NULLIF(SUM(CASE WHEN scope = 'shared' THEN cost END), 0) AS shared_share,
                 SUM(CASE WHEN sku LIKE '%FREE%' THEN quantity * project_share ELSE 0 END) AS free_quantity,
                 SUM(quantity * project_share) AS quantity
          FROM ${VIEW} WHERE ${MINE} GROUP BY 1`),
        runSql(`
          SELECT sku, product, unit, SUM(quantity * project_share) AS quantity, SUM(cost * project_share) AS cost
          FROM ${VIEW} WHERE ${MINE} AND cost > 0 GROUP BY 1, 2, 3 ORDER BY cost DESC LIMIT 12`),
        runSql(`
          SELECT MIN(CASE WHEN scope = 'project' THEN usage_date END) AS first_day, MAX(usage_date) AS last_day,
                 MAX(currency) AS currency, MAX(data_through) AS data_through,
                 SUM(cost) AS workspace_cost, SUM(cost * project_share) AS project_cost,
                 SUM(CASE WHEN scope = 'shared' THEN cost * project_share END) / NULLIF(SUM(CASE WHEN scope = 'shared' THEN cost END), 0) AS shared_share
          FROM ${VIEW}`),
      ]);
      const n = (v: string | null | undefined) => Number(v ?? 0);
      const body = {
        available: true, ...meta,
        workspace_cost: n(meta?.workspace_cost), project_cost: n(meta?.project_cost),
        shared_share: meta?.shared_share == null ? null : n(meta.shared_share),
        daily: daily.map((r) => ({ day: r.day, product: r.product, cost: n(r.cost) })),
        services: services.map((r) => ({
          product: r.product, cost: n(r.cost), quantity: n(r.quantity), free_quantity: n(r.free_quantity),
          shared_share: r.shared_share == null ? null : n(r.shared_share),
        })),
        skus: skus.map((r) => ({ ...r, quantity: n(r.quantity), cost: n(r.cost) })),
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
