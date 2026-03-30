import { getConfig } from './config.js';
import { writeFileSync, mkdirSync } from 'fs';

// ── Snowflake ────────────────────────────────────────────────────

const SF_SKIP_SCHEMAS = new Set(['INFORMATION_SCHEMA']);
const SF_SKIP_DBS     = new Set(['SNOWFLAKE']);

function sfParseDataType(raw) {
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return raw; }
  }
  if (typeof raw !== 'object' || !raw) return String(raw);
  const t = raw.type;
  if (t === 'FIXED') return `NUMBER(${raw.precision},${raw.scale})`;
  if (t === 'TEXT')  return raw.length ? `VARCHAR(${raw.length})` : 'VARCHAR';
  if (t === 'REAL')  return 'FLOAT';
  return t || 'UNKNOWN';
}

async function sfCrawlColumns(conn, execute, db, schema, obj) {
  const rows = await execute(conn,
    `SHOW COLUMNS IN TABLE "${db}"."${schema}"."${obj}"`
  );
  return rows.map(c => ({
    name:     c['column_name'],
    type:     sfParseDataType(c['data_type']),
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

async function crawlSnowflake(cfg) {
  const { createConnection, execute, destroy } = await import('./snowflake.js');
  const conn = await createConnection();

  try {
    let databases;
    if (cfg.databases?.length) {
      databases = cfg.databases;
    } else {
      const rows = await execute(conn, 'SHOW DATABASES');
      databases = rows.map(r => r.name).filter(n => !SF_SKIP_DBS.has(n));
    }

    console.log(`  databases found: ${databases.length} → ${databases.join(', ')}`);
    const topology = { warehouseType: 'snowflake', databases: [], crawledAt: new Date().toISOString() };

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
        if (SF_SKIP_SCHEMAS.has(s.name)) continue;
        console.log(`  ▸ ${s.name}`);
        const schemaEntry = { name: s.name, tables: [] };

        const tables = await execute(conn, `SHOW TABLES IN SCHEMA "${db}"."${s.name}"`);
        for (const t of tables) {
          console.log(`    ▸ ${t.name} (${t.rows ?? '?'} rows)`);
          const cols = await sfCrawlColumns(conn, execute, db, s.name, t.name);
          schemaEntry.tables.push({ name: t.name, kind: 'TABLE', rows: Number(t.rows) || 0, columns: cols });
        }

        try {
          const views = await execute(conn, `SHOW VIEWS IN SCHEMA "${db}"."${s.name}"`);
          for (const v of views) {
            console.log(`    ▸ ${v.name} (view)`);
            const cols = await sfCrawlColumns(conn, execute, db, s.name, v.name);
            schemaEntry.tables.push({ name: v.name, kind: 'VIEW', rows: 0, columns: cols });
          }
        } catch { /* views may not be accessible */ }

        dbEntry.schemas.push(schemaEntry);
      }
      topology.databases.push(dbEntry);
    }
    return topology;
  } finally {
    await destroy(conn);
  }
}

// ── BigQuery ─────────────────────────────────────────────────────

async function crawlBigQuery(cfg) {
  const { getClient } = await import('./bigquery.js');
  const bq = getClient();

  let datasets;
  if (cfg.datasets?.length) {
    datasets = cfg.datasets.map(id => bq.dataset(id));
  } else {
    [datasets] = await bq.getDatasets();
  }

  console.log(`  datasets found: ${datasets.length} → ${datasets.map(d => d.id).join(', ')}`);
  const topology = {
    warehouseType: 'bigquery',
    databases: [{ name: cfg.projectId, schemas: [] }],
    crawledAt: new Date().toISOString(),
  };
  const project = topology.databases[0];

  for (const ds of datasets) {
    console.log(`\n▸ ${ds.id}`);
    const schemaEntry = { name: ds.id, tables: [] };

    const [tables] = await ds.getTables();
    for (const tbl of tables) {
      const [meta] = await tbl.getMetadata();
      const kind = meta.type === 'VIEW' ? 'VIEW' : 'TABLE';
      const rowCount = Number(meta.numRows) || 0;
      console.log(`  ▸ ${tbl.id} (${kind}, ${rowCount} rows)`);

      const columns = (meta.schema?.fields || []).map(f => ({
        name:     f.name,
        type:     f.type + (f.mode === 'REPEATED' ? ' ARRAY' : ''),
        nullable: f.mode !== 'REQUIRED',
        comment:  f.description || null,
      }));

      schemaEntry.tables.push({ name: tbl.id, kind, rows: rowCount, columns });
    }
    project.schemas.push(schemaEntry);
  }

  return topology;
}

// ── Dispatcher ───────────────────────────────────────────────────

export async function crawlTopology() {
  const cfg = getConfig();
  const type = cfg.warehouseType;

  let topology;
  if (type === 'snowflake') {
    topology = await crawlSnowflake(cfg.warehouse);
  } else if (type === 'bigquery') {
    topology = await crawlBigQuery(cfg.warehouse);
  } else {
    throw new Error(`Unknown WAREHOUSE_TYPE: "${type}"`);
  }

  mkdirSync('data', { recursive: true });
  writeFileSync('data/topology.json', JSON.stringify(topology, null, 2));

  const total = topology.databases.flatMap(d => d.schemas).flatMap(s => s.tables).length;
  console.log(`\n✓ Crawl complete — ${total} tables/views saved to data/topology.json`);
  return topology;
}
