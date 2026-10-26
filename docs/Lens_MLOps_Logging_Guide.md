# Lens MLOps logging: what goes where

Lens MLOps keeps two kinds of records. They do different jobs, and they are not duplicates.

| | **Lakebase** (the app's own records) | **App telemetry** (Unity Catalog) |
|---|---|---|
| **In one line** | What people asked, and how each answer was produced | What the app server did, second by second |
| **Written by** | The Lens MLOps app | Databricks, automatically |
| **Where** | Lakebase database, `chatapp` schema (org v1: database `lensmlopsv1`) | `<catalog>.<prefix>_telemetry` (org v1: `collectionanalytics1.lens_mlops_v1_telemetry`) |
| **Seen in** | The app: Observability, chat history | Databricks SQL editor |
| **Best for** | Quality, usage, audit of answers | Errors, outages, slowness |
| **If Lakebase is down** | Nothing can be written | Still recorded, so it shows *why* |

## Lakebase: the app's own records

| Table | What it keeps |
|---|---|
| `chat_sessions` | Each conversation: who, title, when |
| `chat_messages` | Every question and answer, with charts and feedback (👍/👎) |
| `usage_log` | One row per question: how it was routed, Quick or Deep, SQL run, models used, tokens, time per step, quality scores, guardrail actions. This drives Observability. |
| `answer_cache`, `cache_versions` | Saved answers reused for repeat questions, and when the data last changed |
| `eval_cases`, `eval_runs`, `eval_results` | Evaluation questions (routing, guardrail, policy, accuracy), test runs and their results |
| `prewarm_runs` | When suggested questions were pre-answered |

## App telemetry: the server's records

| Table | What it keeps |
|---|---|
| `lens_mlops_otel_logs` | Every line the server writes: each request (user, page, status) and every **`[error]` line with its exact message and stack trace**. Use this for troubleshooting. |
| `lens_mlops_otel_metrics` | Measurements every few seconds: response times, memory, Lakebase connections |
| `lens_mlops_otel_spans` | Timed steps inside each request, to see where a slow request spent its time |
| `lens_mlops_otel_annotations` | Notes people can add to traces; created by Databricks and empty unless used |

The deploy's app step switches telemetry on with `"app_telemetry": true` in the config (org v1); `false` switches it off (personal, to save cost).

## Which one do I look at?

| Question | Look in |
|---|---|
| What did users ask, and were the answers good? | Lakebase, through **Observability** in the app |
| Why was a question routed to Deep analysis? | Lakebase, through **Observability → Pipeline traces** |
| The app showed an error. What went wrong? | Telemetry: `lens_mlops_otel_logs` |
| Was the app slow or overloaded at a given time? | Telemetry: `lens_mlops_otel_metrics` |
| The app was down, or showed "a data service is unavailable". Why? | Telemetry: `lens_mlops_otel_logs` (Lakebase or the warehouse may have been the cause) |

## Handy queries (Databricks SQL editor, org v1)

```sql
-- Recent errors, with message and stack trace
SELECT time, body
FROM collectionanalytics1.lens_mlops_v1_telemetry.lens_mlops_otel_logs
WHERE body LIKE '%[error]%' OR body LIKE '%[unhandledRejection]%'
ORDER BY time DESC;

-- Recent server activity
SELECT time, body
FROM collectionanalytics1.lens_mlops_v1_telemetry.lens_mlops_otel_logs
ORDER BY time DESC LIMIT 50;
```
