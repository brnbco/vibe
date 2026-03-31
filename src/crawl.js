import { getConfig } from './config.js';
import { writeFileSync, mkdirSync } from 'fs';

const PROFILE_BATCH = 50;

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

function findDateColumn(columns) {
  return columns.find(c =>
    /^(DATE|TIMESTAMP|DATETIME|TIMESTAMP_NTZ|TIMESTAMP_LTZ|TIMESTAMP_TZ)$/i.test(c.type)
  );
}

function isNumeric(type) {
  return /NUMBER|FLOAT|REAL|DECIMAL|INT|DOUBLE|NUMERIC|BIGNUMERIC|INTEGER/i.test(type);
}

function isStringLike(type) {
  return /VARCHAR|TEXT|STRING/i.test(type);
}

async function sfProfileTable(conn, execute, fqn, columns) {
  const dateCol = findDateColumn(columns);
  const numCols = columns.filter(c => isNumeric(c.type)).slice(0, PROFILE_BATCH);

  if (numCols.length === 0) return {};

  const exprs = numCols.flatMap(c => [
    `SUM("${c.name}") AS "${c.name}__sum"`,
    `COUNT(CASE WHEN "${c.name}" != 0 AND "${c.name}" IS NOT NULL THEN 1 END) AS "${c.name}__nnz"`,
    `MAX("${c.name}") AS "${c.name}__max"`,
  ]).join(', ');

  const dateFilter = dateCol
    ? `WHERE "${dateCol.name}" >= DATEADD(day, -30, CURRENT_DATE())`
    : '';

  try {
    const [row] = await execute(conn, `SELECT ${exprs} FROM ${fqn} ${dateFilter}`);
    const profile = {};
    for (const c of numCols) {
      const sum = Number(row?.[`${c.name}__sum`]) || 0;
      const nnz = Number(row?.[`${c.name}__nnz`]) || 0;
      const max = Number(row?.[`${c.name}__max`]) || 0;
      if (nnz > 0) profile[c.name] = { sum, nonZeroCount: nnz, max };
    }
    return profile;
  } catch { return {}; }
}

async function sfProfileStrings(conn, execute, fqn, columns) {
  const dateCol = findDateColumn(columns);
  const strCols = columns.filter(c => isStringLike(c.type)).slice(0, 10);
  if (strCols.length === 0) return {};

  const exprs = strCols.map(c =>
    `MAX("${c.name}") AS "${c.name}__sample"`
  ).join(', ');

  const dateFilter = dateCol
    ? `WHERE "${dateCol.name}" >= DATEADD(day, -7, CURRENT_DATE())`
    : '';

  try {
    const [row] = await execute(conn, `SELECT ${exprs} FROM ${fqn} ${dateFilter}`);
    const profile = {};
    for (const c of strCols) {
      const v = row?.[`${c.name}__sample`];
      if (v) profile[c.name] = [String(v)];
    }
    return profile;
  } catch { return {}; }
}

async function sfGetDateRange(conn, execute, fqn, dateCol) {
  if (!dateCol) return null;
  try {
    const [row] = await execute(conn,
      `SELECT MIN("${dateCol.name}") AS mn, MAX("${dateCol.name}") AS mx FROM ${fqn}`
    );
    return { min: String(row.mn), max: String(row.mx) };
  } catch { return null; }
}

function buildSamples(columns, numericProfile, stringProfile, dateRange, dateCol) {
  const samples = {};
  for (const c of columns) {
    const np = numericProfile[c.name];
    if (np) {
      const avg = np.nonZeroCount > 0 ? (np.sum / np.nonZeroCount).toFixed(2) : null;
      samples[c.name] = [`sum=${np.sum}`, `nonzero_rows=${np.nonZeroCount}`, `max=${np.max}`];
      continue;
    }
    const sp = stringProfile[c.name];
    if (sp) { samples[c.name] = sp; continue; }
    if (dateCol && c.name === dateCol.name && dateRange) {
      samples[c.name] = [`range: ${dateRange.min} to ${dateRange.max}`];
    }
  }
  return samples;
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
          const fqn = `"${db}"."${s.name}"."${t.name}"`;
          const dateCol = findDateColumn(cols);
          console.log(`      profiling…`);
          const [numP, strP, dr] = await Promise.all([
            sfProfileTable(conn, execute, fqn, cols),
            sfProfileStrings(conn, execute, fqn, cols),
            sfGetDateRange(conn, execute, fqn, dateCol),
          ]);
          const samples = buildSamples(cols, numP, strP, dr, dateCol);
          schemaEntry.tables.push({
            name: t.name, kind: 'TABLE', rows: Number(t.rows) || 0,
            columns: cols.map(c => ({ ...c, samples: samples[c.name] || [] })),
          });
        }

        try {
          const views = await execute(conn, `SHOW VIEWS IN SCHEMA "${db}"."${s.name}"`);
          for (const v of views) {
            console.log(`    ▸ ${v.name} (view)`);
            const cols = await sfCrawlColumns(conn, execute, db, s.name, v.name);
            const fqn = `"${db}"."${s.name}"."${v.name}"`;
            const dateCol = findDateColumn(cols);
            console.log(`      profiling…`);
            const [numP, strP, dr] = await Promise.all([
              sfProfileTable(conn, execute, fqn, cols),
              sfProfileStrings(conn, execute, fqn, cols),
              sfGetDateRange(conn, execute, fqn, dateCol),
            ]);
            const samples = buildSamples(cols, numP, strP, dr, dateCol);
            schemaEntry.tables.push({
              name: v.name, kind: 'VIEW', rows: 0,
              columns: cols.map(c => ({ ...c, samples: samples[c.name] || [] })),
            });
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

async function bqProfileTable(bq, fqn, columns) {
  const dateCol = findDateColumn(columns);
  const numCols = columns.filter(c => isNumeric(c.type)).slice(0, PROFILE_BATCH);

  if (numCols.length === 0) return {};

  const exprs = numCols.flatMap(c => [
    `SUM(\`${c.name}\`) AS \`${c.name}__sum\``,
    `COUNTIF(\`${c.name}\` IS NOT NULL AND \`${c.name}\` != 0) AS \`${c.name}__nnz\``,
    `MAX(\`${c.name}\`) AS \`${c.name}__max\``,
  ]).join(', ');

  const dateFilter = dateCol
    ? `WHERE \`${dateCol.name}\` >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)`
    : '';

  try {
    const [rows] = await bq.query({
      query: `SELECT ${exprs} FROM \`${fqn}\` ${dateFilter}`,
      useLegacySql: false,
    });
    const row = rows[0];
    const profile = {};
    for (const c of numCols) {
      const sum = Number(row?.[`${c.name}__sum`]) || 0;
      const nnz = Number(row?.[`${c.name}__nnz`]) || 0;
      const max = Number(row?.[`${c.name}__max`]) || 0;
      if (nnz > 0) profile[c.name] = { sum, nonZeroCount: nnz, max };
    }
    return profile;
  } catch { return {}; }
}

async function bqProfileStrings(bq, fqn, columns) {
  const dateCol = findDateColumn(columns);
  const strCols = columns.filter(c => isStringLike(c.type)).slice(0, 10);
  if (strCols.length === 0) return {};

  const exprs = strCols.map(c =>
    `MAX(\`${c.name}\`) AS \`${c.name}__sample\``
  ).join(', ');

  const dateFilter = dateCol
    ? `WHERE \`${dateCol.name}\` >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)`
    : '';

  try {
    const [rows] = await bq.query({
      query: `SELECT ${exprs} FROM \`${fqn}\` ${dateFilter}`,
      useLegacySql: false,
    });
    const row = rows[0];
    const profile = {};
    for (const c of strCols) {
      let v = row?.[`${c.name}__sample`];
      if (v && typeof v === 'object' && v.value !== undefined) v = String(v.value);
      if (v) profile[c.name] = [String(v)];
    }
    return profile;
  } catch { return {}; }
}

async function bqGetDateRange(bq, fqn, dateCol) {
  if (!dateCol) return null;
  try {
    const [rows] = await bq.query({
      query: `SELECT MIN(\`${dateCol.name}\`) AS mn, MAX(\`${dateCol.name}\`) AS mx FROM \`${fqn}\``,
      useLegacySql: false,
    });
    const row = rows[0];
    const mn = row?.mn?.value ? String(row.mn.value) : String(row?.mn);
    const mx = row?.mx?.value ? String(row.mx.value) : String(row?.mx);
    return { min: mn, max: mx };
  } catch { return null; }
}

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

      const fqn = `${cfg.projectId}.${ds.id}.${tbl.id}`;
      const dateCol = findDateColumn(columns);
      console.log(`    profiling…`);

      const numBatches = [];
      const numCols = columns.filter(c => isNumeric(c.type));
      for (let i = 0; i < numCols.length; i += PROFILE_BATCH) {
        numBatches.push(numCols.slice(i, i + PROFILE_BATCH));
      }

      let numericProfile = {};
      for (const batch of numBatches) {
        const exprs = batch.flatMap(c => [
          `SUM(\`${c.name}\`) AS \`${c.name}__sum\``,
          `COUNTIF(\`${c.name}\` IS NOT NULL AND \`${c.name}\` != 0) AS \`${c.name}__nnz\``,
          `MAX(\`${c.name}\`) AS \`${c.name}__max\``,
        ]).join(', ');

        const dateFilter = dateCol
          ? `WHERE \`${dateCol.name}\` >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)`
          : '';

        try {
          const [rows] = await bq.query({
            query: `SELECT ${exprs} FROM \`${fqn}\` ${dateFilter}`,
            useLegacySql: false,
          });
          const row = rows[0];
          for (const c of batch) {
            const sum = Number(row?.[`${c.name}__sum`]) || 0;
            const nnz = Number(row?.[`${c.name}__nnz`]) || 0;
            const max = Number(row?.[`${c.name}__max`]) || 0;
            if (nnz > 0) numericProfile[c.name] = { sum, nonZeroCount: nnz, max };
          }
        } catch { /* skip batch */ }
      }

      const [strP, dr] = await Promise.all([
        bqProfileStrings(bq, fqn, columns),
        bqGetDateRange(bq, fqn, dateCol),
      ]);

      const samples = buildSamples(columns, numericProfile, strP, dr, dateCol);

      schemaEntry.tables.push({
        name: tbl.id, kind, rows: rowCount,
        columns: columns.map(c => ({ ...c, samples: samples[c.name] || [] })),
      });
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
