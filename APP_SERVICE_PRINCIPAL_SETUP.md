# Convert a UI-created Genie app to service-principal authorization

> **When you need this (2026-10-06):** only if an app was created by hand in the Databricks UI. Apps deployed with `deploy/deploy.py` already run as their service principal with these grants applied (the `app` step does it); see [SETUP_GUIDE.md](SETUP_GUIDE.md).


For a Databricks App created from the **AppKit – Genie** template in the UI (**Compute → Apps → Create app**). Out of the box that template calls Genie **as each signed-in user** (user authorization, scope `dashboards.genie`), so every user needs their own Genie, warehouse and table permissions.

After these steps the app calls Genie **as its own service principal**. Users need only **Can use** on the app, plus the **Consumer access** entitlement, and no data access at all.

Tested on AppKit **0.65.0** (app `test-ui-created`): a user with only Can use on the app got answers through the app, while opening the Genie space directly returned `403`.

---

## Before you start: note three values

| Value | Where to find it | Example |
|---|---|---|
| App name | Compute → Apps | `test-ui-created` |
| The app's **service principal ID** | App page (Authorization / service principal), or `databricks apps get <app> -o json` → `service_principal_client_id` | `a174eae7-afad-4350-b981-6f6374441f98` |
| The **Genie space** and the **SQL warehouse it uses** | Genie space → Settings (warehouse) | space `Lens MLOps Analytics`, warehouse `Serverless Starter Warehouse` |

You also need the catalog, schema and tables the Genie space reads, e.g. `cnx_automl_dev.lens_mlops_gold`.

---

## Step 1: Change the app's authorization settings

**Compute → Apps → (your app) → Edit** → **Configure**:

1. **App resources**
   - **Genie space:** change the permission from **Can view** to **Can run**. Can view isn't enough to *ask* questions.
   - **+ Add resource → SQL warehouse:** choose the warehouse the Genie space uses, permission **Can use**. Genie runs its SQL on it as the caller.
2. **User authorization:** remove the scope **`dashboards.genie`**. The app then no longer receives user tokens, and users no longer see a consent prompt.
3. **Save.**

<details><summary>Same with the CLI</summary>

Save as `app_spec.json`. Send the full list of resources: an update replaces them. Leave out `compute_size`: this update call rejects it.

```json
{
  "description": "Genie chat app (service-principal authorization)",
  "user_api_scopes": [],
  "resources": [
    {"name": "genie-space", "description": "Genie space",
     "genie_space": {"name": "<Genie space title>", "space_id": "<space id>", "permission": "CAN_RUN"}},
    {"name": "sql-warehouse", "description": "Warehouse the Genie space runs on",
     "sql_warehouse": {"id": "<warehouse id>", "permission": "CAN_USE"}}
  ]
}
```
```
databricks apps update <app-name> --json @app_spec.json
```
</details>

---

## Step 2: Change one file in the code, `server/server.ts`

**Why a code change is needed:** the template's Genie plugin serves its API routes (`/api/genie/…`) through `asUser(req)`, and has no setting to change that. Without a user token (step 1 removed the scope), those routes fail with an authentication error. The replacement below serves the **same routes** without `asUser`, so the chat screen (`<GenieChat>`) needs no change.

1. Open the app's source folder: on the app page, follow the **source code** path (e.g. `/Workspace/Users/<you>/databricks_apps/<app>_<date>/appkit-genie`).
2. Open **`server/server.ts`**. The template's version is just:
   ```ts
   import { createApp, genie, server } from '@databricks/appkit';

   createApp({
     plugins: [
       genie(),
       server(),
     ],
   }).catch(console.error);
   ```
3. **Replace the whole file** with:
   ```ts
   import { createApp, genie, server } from '@databricks/appkit';

   // Service-principal authorization for Genie: the same /api/genie routes as the
   // template, without asUser(req), so every call runs as the app's service principal.
   const genieFactory = genie();

   class ServicePrincipalGenie extends genieFactory.plugin {
     injectRoutes(router: any) {
       this.route(router, {
         name: 'sendMessage',
         method: 'post',
         path: '/:alias/messages',
         handler: async (req: any, res: any) => this._handleSendMessage(req, res),
       });
       this.route(router, {
         name: 'getConversation',
         method: 'get',
         path: '/:alias/conversations/:conversationId',
         handler: async (req: any, res: any) => this._handleGetConversation(req, res),
       });
       this.route(router, {
         name: 'getMessage',
         method: 'get',
         path: '/:alias/conversations/:conversationId/messages/:messageId',
         handler: async (req: any, res: any) => this._handleGetMessage(req, res),
       });
     }
   }

   createApp({
     plugins: [
       { ...genieFactory, plugin: ServicePrincipalGenie },
       server(),
     ],
   }).catch(console.error);
   ```
4. Save the file.
5. Back on the app page, click **Deploy** and use the same source folder. Wait for **"App started successfully"** (1–2 minutes).

<details><summary>Same with the CLI</summary>

Run from a folder that is **not** the app's own folder (its `databricks.yml` can redirect the CLI):
```
databricks workspace import "<source folder>/server/server.ts" --file server.ts --format AUTO --overwrite
databricks apps deploy <app-name> --source-code-path "<source folder>"
```
</details>

---

## Step 3: Give the service principal the data

Run in the SQL editor, with the service principal's **ID** in backticks:

```sql
GRANT USE CATALOG ON CATALOG <catalog>          TO `<service principal id>`;
GRANT USE SCHEMA  ON SCHEMA  <catalog>.<schema> TO `<service principal id>`;
GRANT SELECT      ON SCHEMA  <catalog>.<schema> TO `<service principal id>`;
```

- **`USE CATALOG`** needs the catalog owner, `MANAGE` on the catalog, or a metastore admin. In a shared catalog, ask them for this line: it lets the app *enter* the catalog but reads no data.
- **`USE SCHEMA` and `SELECT`** can be granted by the schema's owner, for example you, if you created the schema.
- **Views** run with their owner's rights, so the service principal needs no access to the tables *behind* them.

Check it worked:
```sql
SHOW GRANTS `<service principal id>` ON SCHEMA <catalog>.<schema>;
```

---

## Step 4: Give users access to the app only

1. **Settings → Identity and access → Groups → Add group**, e.g. `genie-app-users`, and add the users.
2. Give the group (or the users) the **Consumer access** entitlement **only**.
3. **Compute → Apps → (your app) → Permissions → Add** → the group → **Can use** → **Save**.

Don't give users the Genie space, the warehouse or the tables. The app reaches those through its service principal.

---

## Step 5: Test with a user who has no data access

Have someone who has **only Can use on the app** (and no Genie or table access) open the app URL and ask a question.

| What they see | Meaning | Fix |
|---|---|---|
| An answer | ✅ Done: the app uses its service principal | — |
| "You don't have access" / `401` **right after** you granted access | Permissions take a minute to apply | Wait a minute and retry |
| Error mentioning a missing **user token** / authentication | The old `server.ts` (with `asUser`) is still running | Redo step 2, and make sure the deploy **succeeded** |
| Genie "permission denied" on the space | The Genie resource is still **Can view** | Step 1: set it to **Can run** |
| Genie **internal error**, or no answer with data | The service principal can't read the tables | Step 3, especially `USE CATALOG` |
| `This API is disabled for users without the databricks-sql-access or workspace-consume entitlements` | The service principal lacks the SQL entitlement | Admin: **Settings → Identity and access → Service principals → (app's service principal) → Databricks SQL access** |

Also confirm the other direction: the same person opening the Genie space directly should get **permission denied**. That proves users only reach the data through the app.

Errors are also visible under **Compute → Apps → (your app) → Logs**.

---

## Switching back to user authorization

1. **Edit → Configure → User authorization → + Add scope → `dashboards.genie`**, then **Save**.
2. Restore the template's original `server/server.ts` (step 2, point 2) and **Deploy**.
3. Give **each user** (or a group) **Can run** on the Genie space, **Can use** on the warehouse, and `USE CATALOG` / `USE SCHEMA` / `SELECT` on the data.

---

## Good to know

- **Everyone sees the same data.** With service-principal authorization, per-user data rules (row filters, column masks) don't apply, and Databricks audit logs show the service principal rather than the person. Record the signed-in user yourself if you need it; the app receives it in the `x-forwarded-email` header.
- **Local testing can mislead.** In local development (`NODE_ENV=development`), AppKit quietly falls back to the service principal even with the old code, so it only shows the difference once deployed.
- **Retest after upgrading AppKit.** The replacement file calls the plugin's internal handlers (`_handleSendMessage` and friends), which are internal and could be renamed in a newer version.
- **Recreating the app changes its identity.** A deleted and recreated app gets a **new** service principal, so repeat step 3 for the new ID (step 1's resources are part of the app's settings).
