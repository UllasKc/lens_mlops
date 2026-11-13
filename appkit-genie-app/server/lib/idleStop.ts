import type express from 'express';
import { getExecutionContext } from '@databricks/appkit';
import { evalRunning } from './evals.js';

/**
 * Stops this app after a stretch with no use, because Databricks Apps never stop on their own and
 * bill while running. Someone with CAN_MANAGE on the app starts it again (Compute -> Apps -> Start).
 *
 * Use = a request from a signed-in person or service principal (the platform's proxy adds
 * x-forwarded-email); probes without an identity don't count. An answer still streaming, or an
 * evaluation run in progress, keeps the app up. The app stops itself with its own service
 * principal, which the deploy gives CAN_MANAGE on this app only.
 *
 * LENSS_IDLE_STOP_MINUTES (deploy config `idle_stop_minutes`; 0 = never) and LENSS_APP_NAME come
 * from app.yaml.
 */

const MINUTES = Number(process.env.LENSS_IDLE_STOP_MINUTES ?? 0);
const APP = process.env.LENSS_APP_NAME || process.env.DATABRICKS_APP_NAME || '';
const CHECK_EVERY_MS = 5 * 60_000;

let lastUse = Date.now();   // a fresh start counts as use, so the app gets a full window first
let inFlight = 0;
let stopping = false;

/** Express middleware: records each request from a signed-in caller. */
export function trackUse(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const who = req.headers['x-forwarded-email'];
  if (typeof who === 'string' && who) {
    lastUse = Date.now();
    inFlight += 1;
    res.on('close', () => { inFlight -= 1; lastUse = Date.now(); });
  }
  next();
}

/** Minutes since the last request from a person or service principal. */
export const idleMinutes = () => (Date.now() - lastUse) / 60_000;

export function startIdleStop(): void {
  if (!MINUTES || !APP) {
    console.log(`[idle stop] off${!APP ? ' (app name unknown)' : ''}`);
    return;
  }
  console.log(`[idle stop] on: ${APP} stops after ${MINUTES} minutes without use`);
  setInterval(async () => {
    if (stopping || inFlight > 0 || evalRunning() || idleMinutes() < MINUTES) return;
    stopping = true;
    console.log(`[idle stop] no use for ${Math.round(idleMinutes())} minutes: stopping ${APP}`);
    try {
      await getExecutionContext().client.apiClient.request({
        path: `/api/2.0/apps/${encodeURIComponent(APP)}/stop`,
        method: 'POST',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        raw: false,
        payload: {},
      } as never);
    } catch (err) {
      // Most likely the service principal lacks CAN_MANAGE on the app: try again after another window.
      console.warn('[idle stop] could not stop the app:', err instanceof Error ? err.message : err);
      lastUse = Date.now();
      stopping = false;
    }
  }, CHECK_EVERY_MS).unref();
}
