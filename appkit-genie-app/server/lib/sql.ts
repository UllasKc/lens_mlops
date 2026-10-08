import { getExecutionContext } from '@databricks/appkit';

const WAREHOUSE_ID = process.env.DATABRICKS_WAREHOUSE_ID ?? '';

/** Runs a SQL statement against the configured warehouse and returns rows as
 * plain objects keyed by column name. Only for small, fast aggregate queries
 * (dashboard tiles/tables) — not meant for large result sets. */
export async function runSql(statement: string): Promise<Record<string, string | null>[]> {
  if (!WAREHOUSE_ID) throw new Error('DATABRICKS_WAREHOUSE_ID is not configured');
  const client = getExecutionContext().client;

  let response = await client.statementExecution.executeStatement({
    warehouse_id: WAREHOUSE_ID,
    statement,
    wait_timeout: '30s',
    disposition: 'INLINE',
    format: 'JSON_ARRAY',
  });

  while (response.status?.state === 'PENDING' || response.status?.state === 'RUNNING') {
    await new Promise((r) => setTimeout(r, 500));
    response = await client.statementExecution.getStatement({ statement_id: response.statement_id! });
  }

  if (response.status?.state !== 'SUCCEEDED') {
    throw new Error(response.status?.error?.message ?? `SQL statement did not succeed: ${response.status?.state}`);
  }

  const columns = response.manifest?.schema?.columns ?? [];
  const rows = response.result?.data_array ?? [];
  return rows.map((row) => {
    const obj: Record<string, string | null> = {};
    columns.forEach((col, i) => {
      obj[col.name ?? `col${i}`] = row[i] ?? null;
    });
    return obj;
  });
}
