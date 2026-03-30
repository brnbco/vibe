import { createConnection, execute, destroy } from './snowflake.js';

export async function executeSQL(sql) {
  const conn = await createConnection();
  try {
    const rows = await execute(conn, sql);

    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return { columns, rows, rowCount: rows.length };
  } finally {
    await destroy(conn);
  }
}

export function formatResults({ columns, rows, rowCount }) {
  if (rowCount === 0) {
    return '(no rows returned)';
  }

  const widths = columns.map(col =>
    Math.max(col.length, ...rows.map(r => String(r[col] ?? '').length))
  );

  const cap = 40;
  const capped = widths.map(w => Math.min(w, cap));

  const pad = (val, i) => {
    const s = String(val ?? '');
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
