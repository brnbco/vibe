import { createConnection, execute, destroy } from './snowflake.js';
import { getConfig } from './config.js';
import { writeFileSync, mkdirSync } from 'fs';

const SKIP_SCHEMAS = new Set(['INFORMATION_SCHEMA']);
const SKIP_DBS = new Set(['SNOWFLAKE']);

function parseDataType(raw) {
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return raw; }
  }
  if (typeof raw !== 'object' || !raw) return String(raw);
  const t = raw.type;
  if (t === 'FIXED')  return `NUMBER(${raw.precision},${raw.scale})`;
  if (t === 'TEXT')   return raw.length ? `VARCHAR(${raw.length})` : 'VARCHAR';
  if (t === 'REAL')   return 'FLOAT';
  return t || 'UNKNOWN';
}

async function crawlColumns(conn, db, schema, objectName) {
  const rows = await execute(conn,
    `SHOW COLUMNS IN TABLE "${db}"."${schema}"."${objectName}"`
  );
  return rows.map(c => ({
    name:     c['column_name'],
    type:     parseDataType(c['data_type']),
    nullable: (() => {
      const dt = c['data_type'];
      if (typeof dt === 'string') {
        try { return JSON.parse(dt).nullable ?? true; } catch { return true; }
      }
      return dt?.nullable ?? true;
    })(),
    comment: c['comment'] || null,
  }));
}

export async function crawlTopology() {
  const cfg  = getConfig();
  const conn = await createConnection();

  try {
    let databases;
    if (cfg.crawl.databases?.length) {
      databases = cfg.crawl.databases;
    } else {
      const rows = await execute(conn, 'SHOW DATABASES');
      databases = rows.map(r => r.name).filter(n => !SKIP_DBS.has(n));
    }

    console.log(`  databases found: ${databases.length} → ${databases.join(', ')}`);
    const topology = { databases: [], crawledAt: new Date().toISOString() };

    for (const db of databases) {
      console.log(`\n▸ ${db}`);
      const dbEntry = { name: db, schemas: [] };

      let schemas;
      try {
        schemas = await execute(conn, `SHOW SCHEMAS IN DATABASE "${db}"`);
      } catch (e) {
        console.log(`  ⚠ skipping (${e.message})`);
        continue;
      }

      for (const s of schemas) {
        if (SKIP_SCHEMAS.has(s.name)) continue;
        console.log(`  ▸ ${s.name}`);
        const schemaEntry = { name: s.name, tables: [] };

        const tables = await execute(conn,
          `SHOW TABLES IN SCHEMA "${db}"."${s.name}"`
        );

        for (const t of tables) {
          console.log(`    ▸ ${t.name} (${t.rows ?? '?'} rows)`);
          const cols = await crawlColumns(conn, db, s.name, t.name);
          schemaEntry.tables.push({
            name: t.name, kind: 'TABLE', rows: Number(t.rows) || 0, columns: cols,
          });
        }

        try {
          const views = await execute(conn,
            `SHOW VIEWS IN SCHEMA "${db}"."${s.name}"`
          );
          for (const v of views) {
            console.log(`    ▸ ${v.name} (view)`);
            const cols = await crawlColumns(conn, db, s.name, v.name);
            schemaEntry.tables.push({
              name: v.name, kind: 'VIEW', rows: 0, columns: cols,
            });
          }
        } catch { /* views may not be accessible */ }

        dbEntry.schemas.push(schemaEntry);
      }
      topology.databases.push(dbEntry);
    }

    mkdirSync('data', { recursive: true });
    writeFileSync('data/topology.json', JSON.stringify(topology, null, 2));

    const total = topology.databases
      .flatMap(d => d.schemas).flatMap(s => s.tables).length;
    console.log(`\n✓ Crawl complete — ${total} tables/views saved to data/topology.json`);
    return topology;
  } finally {
    await destroy(conn);
  }
}
