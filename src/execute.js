import { getConfig } from './config.js';

async function executeSnowflake(sql) {
  const { createConnection, execute, destroy } = await import('./snowflake.js');
  const conn = await createConnection();
  try {
    const rows = await execute(conn, sql);
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return { columns, rows, rowCount: rows.length };
  } finally {
    await destroy(conn);
  }
}

async function executeBigQuery(sql) {
  const { runQuery } = await import('./bigquery.js');
  const rows = await runQuery(sql);
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { columns, rows, rowCount: rows.length };
}

export async function executeSQL(sql) {
  const { warehouseType } = getConfig();
  if (warehouseType === 'snowflake') return executeSnowflake(sql);
  if (warehouseType === 'bigquery')  return executeBigQuery(sql);
  throw new Error(`Unknown WAREHOUSE_TYPE: "${warehouseType}"`);
}

export function formatResults({ columns, rows, rowCount }) {
  if (rowCount === 0) {
    return '(no rows returned)';
  }

  const scalar = (v) => {
    if (v == null) return '';
    if (Array.isArray(v)) return v.map(item => {
      if (typeof item === 'object' && item !== null) {
        return Object.entries(item).map(([k, val]) => `${k}=${val}`).join(', ');
      }
      return String(item);
    }).join(' | ');
    if (typeof v === 'object' && v.value !== undefined) return String(v.value);
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'object' && v !== null) {
      return Object.entries(v).map(([k, val]) => `${k}=${val}`).join(', ');
    }
    return String(v);
  };

  const widths = columns.map(col =>
    Math.max(col.length, ...rows.map(r => scalar(r[col]).length))
  );

  const cap = 40;
  const capped = widths.map(w => Math.min(w, cap));

  const fmt = (val) => scalar(val);

  const pad = (val, i) => {
    const s = fmt(val);
    return s.length > cap ? s.slice(0, cap - 1) + '…' : s.padEnd(capped[i]);
  };

  const header = columns.map((c, i) => pad(c, i)).join(' │ ');
  const sep    = capped.map(w => '─'.repeat(w)).join('─┼─');
  const body   = rows.slice(0, 100).map(r =>
    columns.map((c, i) => pad(r[c], i)).join(' │ ')
  ).join('\n');

  const truncNote = rowCount > 100 ? `\n… (${rowCount - 100} more rows)` : '';
  return `${header}\n${sep}\n${body}${truncNote}\n\n${rowCount} row(s)`;
}
