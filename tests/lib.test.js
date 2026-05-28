import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCompilerContext,
  filterColumns,
  tokenize,
  stem,
  expandQueryTokens,
  isStructuralColumn,
  parseDataVolume,
  compileSQLWithClient,
  recompileSQLWithClient,
  searchOntologyWithClients,
  buildProfileSqlForBigQuery,
  buildProfileSqlForSnowflake,
  buildDateWindowWhere,
  prioritizeColumnsForDdl,
  tableToEmbedText,
  tableToFullDDL,
  SUPPORTED_DIALECTS,
  DEFAULT_CHAT_MODEL,
  DEFAULT_EMBED_MODEL,
  CLICKHOUSE_REFUSAL_ERROR,
} from '../src/lib.js';
import { SYSTEM_PROMPT } from '../src/compile.js';

// =======================================================================
// Constants
// =======================================================================

test('SUPPORTED_DIALECTS contains bigquery and snowflake', () => {
  assert.deepEqual([...SUPPORTED_DIALECTS].sort(), ['bigquery', 'snowflake']);
});

test('SUPPORTED_DIALECTS does not contain clickhouse', () => {
  assert.equal(SUPPORTED_DIALECTS.includes('clickhouse'), false);
});

test('DEFAULT_CHAT_MODEL is gpt-5.4 (not gpt-4o)', () => {
  assert.equal(DEFAULT_CHAT_MODEL, 'gpt-5.4');
});

test('DEFAULT_EMBED_MODEL is text-embedding-3-small (matches MCP)', () => {
  assert.equal(DEFAULT_EMBED_MODEL, 'text-embedding-3-small');
});

// =======================================================================
// SYSTEM_PROMPT — Round 9 forbidden-constructs block (V29 defense-in-depth)
// =======================================================================
//
// The MCP-side SQL validator is the load-bearing barrier against
// OBJECT_CONSTRUCT(*), IDENTIFIER(...), and $N positional refs. These
// assertions lock the system prompt so a future edit doesn't accidentally
// remove the LLM-side guard, which would re-open the easy prompt-injection
// path even though the validator would still catch the resulting SQL.

test('SYSTEM_PROMPT contains FORBIDDEN CONSTRUCTS block (R9 V29)', () => {
  const prompt = SYSTEM_PROMPT('snowflake');
  assert.match(prompt, /FORBIDDEN CONSTRUCTS/);
});

test('SYSTEM_PROMPT forbids OBJECT_CONSTRUCT(*) (R9 V26)', () => {
  const prompt = SYSTEM_PROMPT('snowflake');
  assert.match(prompt, /OBJECT_CONSTRUCT\(\*\)/);
});

test('SYSTEM_PROMPT forbids IDENTIFIER() (R9 V27)', () => {
  const prompt = SYSTEM_PROMPT('snowflake');
  assert.match(prompt, /IDENTIFIER\('<anything>'\)/);
});

test('SYSTEM_PROMPT forbids $N positional refs (R9 V28)', () => {
  const prompt = SYSTEM_PROMPT('snowflake');
  assert.match(prompt, /Positional column references/);
  assert.match(prompt, /\$1/);
});

test('SYSTEM_PROMPT still allows COUNT(*) as the only star-in-function exception', () => {
  const prompt = SYSTEM_PROMPT('snowflake');
  assert.match(prompt, /COUNT\(\*\) is the only allowed/i);
});

test('SYSTEM_PROMPT forbids double-quoted bareword identifiers (R10 V32)', () => {
  const prompt = SYSTEM_PROMPT('snowflake');
  assert.match(prompt, /[Dd]ouble-quoted bareword identifiers/);
  assert.match(prompt, /"COLUMN_NAME"/);
});

// =======================================================================
// Pure helpers
// =======================================================================

test('tokenize lowercases, strips non-alnum, drops short tokens', () => {
  assert.deepEqual(tokenize('Oats Overnight Facebook ROAS!'), ['oats', 'overnight', 'facebook', 'roas']);
});

test('stem strips trailing s, ing, ed', () => {
  assert.equal(stem('customers'), 'customer');
  assert.equal(stem('running'), 'runn');
  assert.equal(stem('purchased'), 'purchas');
  assert.equal(stem('id'), 'id');
});

test('expandQueryTokens dedupes stem + raw', () => {
  const out = expandQueryTokens(['customer', 'customers']);
  assert.equal(out.has('customer'), true);
  assert.equal(out.has('customers'), true);
});

test('isStructuralColumn matches dates and id/name patterns', () => {
  assert.equal(isStructuralColumn('order_date', 'DATE'), true);
  assert.equal(isStructuralColumn('user_id', 'STRING'), true);
  assert.equal(isStructuralColumn('product_name', 'STRING'), true);
  assert.equal(isStructuralColumn('amount_spent', 'NUMBER'), false);
});

test('parseDataVolume reads nonzero_rows or nonnull_rows from line', () => {
  assert.equal(parseDataVolume('  - foo (NUMBER) e.g. 12.5, nonzero_rows=42'), 42);
  assert.equal(parseDataVolume('  - bar (STRING) e.g. "x", nonnull_rows=100'), 100);
  assert.equal(parseDataVolume('  - baz (DATE)'), 0);
});

test('filterColumns is no-op when total cols <= cap', () => {
  const ddl = `Table: db.s.t\n  - a (NUMBER)\n  - b (STRING)`;
  const out = filterColumns(ddl, new Set(['anything']));
  assert.equal(out, ddl);
});

test('filterColumns reduces wide tables but always keeps structural columns', () => {
  const lines = ['Table: db.s.t', 'Type: BASE TABLE'];
  for (let i = 0; i < 50; i++) lines.push(`  - col_${i} (NUMBER)`);
  lines.push('  - order_date (DATE)');
  lines.push('  - customer_id (STRING)');
  const ddl = lines.join('\n');
  const out = filterColumns(ddl, new Set(['random_token']));
  assert.match(out, /order_date \(DATE\)/);
  assert.match(out, /customer_id \(STRING\)/);
  assert.match(out, /less-relevant columns omitted/);
});

test('buildCompilerContext joins multiple table contexts', () => {
  const matches = [
    { id: 'db.s.t1', kind: 'BASE TABLE', ddl: 'Table: db.s.t1\n  - a (NUMBER)\n  - b (STRING)' },
    { id: 'db.s.t2', kind: 'VIEW', ddl: 'Table: db.s.t2\n  - x (NUMBER)\n  - y (STRING)' },
  ];
  const ctx = buildCompilerContext('foo', matches);
  assert.match(ctx, /TABLE: db\.s\.t1/);
  assert.match(ctx, /TABLE: db\.s\.t2/);
});

// =======================================================================
// tableToEmbedText / tableToFullDDL — pure embed helpers
// =======================================================================

test('tableToFullDDL emits all columns with sample values when present', () => {
  const out = tableToFullDDL('db', 's', {
    name: 't',
    kind: 'BASE TABLE',
    rows: 1234,
    columns: [
      { name: 'order_date', type: 'DATE', nullable: false, comment: null, samples: ['2026-01-01'] },
      { name: 'amount', type: 'NUMBER', nullable: true, comment: 'usd', samples: [12.5, 7.0] },
    ],
  });
  assert.match(out, /Table: db\.s\.t/);
  assert.match(out, /Approximate Rows: 1234/);
  assert.match(out, /order_date \(DATE, NOT NULL\) e\.g\. 2026-01-01/);
  assert.match(out, /amount \(NUMBER\) — usd e\.g\. 12\.5, 7/);
});

test('tableToEmbedText caps to MAX_EMBED_COLS=50 and prefers samples', () => {
  const cols = [];
  for (let i = 0; i < 60; i++) cols.push({ name: `c${i}`, type: 'NUMBER', nullable: true });
  cols.push({ name: 'with_sample', type: 'STRING', nullable: true, samples: ['hi'] });
  const out = tableToEmbedText('db', 's', { name: 't', kind: 'BASE TABLE', columns: cols });
  assert.match(out, /with_sample \(STRING\) e\.g\. hi/);
  assert.match(out, /more columns/);
});

// =======================================================================
// Profile SQL builders (pure, dialect-aware)
// =======================================================================

test('buildProfileSqlForBigQuery emits SAFE-aggregated SUM/COUNT/MAX with date window', () => {
  const sql = buildProfileSqlForBigQuery({
    fqn: '`p.d.t`',
    numericColumns: [{ name: 'amount' }, { name: 'qty' }],
    dateColumn: { name: 'order_date' },
    dayWindow: 7,
  });
  assert.match(sql, /SELECT/);
  assert.match(sql, /SUM\(`amount`\)/);
  assert.match(sql, /SUM\(`qty`\)/);
  assert.match(sql, /WHERE `order_date` >= DATE_SUB\(CURRENT_DATE\(\), INTERVAL 7 DAY\)/);
  assert.match(sql, /FROM `p\.d\.t`/);
});

test('buildProfileSqlForBigQuery uses TIMESTAMP_SUB for TIMESTAMP date columns', () => {
  // Bug from 2026-04-29 user test: BigQuery rejects DATE >= TIMESTAMP
  // comparison with "No matching signature for operator >=". Builder must
  // dispatch on date-column type so the WHERE expression matches.
  const sql = buildProfileSqlForBigQuery({
    fqn: '`p.d.t`',
    numericColumns: [{ name: 'amount' }],
    dateColumn: { name: 'monitoring_timestamp', type: 'TIMESTAMP' },
    dayWindow: 30,
  });
  assert.match(sql, /WHERE `monitoring_timestamp` >= TIMESTAMP_SUB\(CURRENT_TIMESTAMP\(\), INTERVAL 30 DAY\)/);
});

test('buildProfileSqlForBigQuery uses DATETIME_SUB for DATETIME date columns', () => {
  const sql = buildProfileSqlForBigQuery({
    fqn: '`p.d.t`',
    numericColumns: [{ name: 'amount' }],
    dateColumn: { name: 'event_dt', type: 'DATETIME' },
    dayWindow: 14,
  });
  assert.match(sql, /WHERE `event_dt` >= DATETIME_SUB\(CURRENT_DATETIME\(\), INTERVAL 14 DAY\)/);
});

test('buildProfileSqlForBigQuery defaults to DATE_SUB when type is missing (back-compat)', () => {
  const sql = buildProfileSqlForBigQuery({
    fqn: '`p.d.t`',
    numericColumns: [{ name: 'amount' }],
    dateColumn: { name: 'order_date' },
    dayWindow: 30,
  });
  assert.match(sql, /DATE_SUB\(CURRENT_DATE\(\), INTERVAL 30 DAY\)/);
});

test('buildProfileSqlForBigQuery omits WHERE when dateColumn missing', () => {
  const sql = buildProfileSqlForBigQuery({
    fqn: '`p.d.t`',
    numericColumns: [{ name: 'amount' }],
    dateColumn: null,
  });
  assert.equal(sql.includes('WHERE'), false);
});

test('buildProfileSqlForSnowflake emits Snowflake DATEADD WHERE clause for DATE', () => {
  const sql = buildProfileSqlForSnowflake({
    fqn: '"DB"."S"."T"',
    numericColumns: [{ name: 'AMOUNT' }],
    dateColumn: { name: 'ORDER_DATE', type: 'DATE' },
    dayWindow: 30,
  });
  assert.match(sql, /SUM\("AMOUNT"\)/);
  assert.match(sql, /WHERE "ORDER_DATE" >= DATEADD\(day, -30, CURRENT_DATE\(\)\)/);
});

test('buildProfileSqlForSnowflake uses CURRENT_TIMESTAMP for TIMESTAMP_NTZ date columns', () => {
  const sql = buildProfileSqlForSnowflake({
    fqn: '"DB"."S"."T"',
    numericColumns: [{ name: 'AMOUNT' }],
    dateColumn: { name: 'EVENT_TS', type: 'TIMESTAMP_NTZ' },
    dayWindow: 30,
  });
  assert.match(sql, /WHERE "EVENT_TS" >= DATEADD\(day, -30, CURRENT_TIMESTAMP\(\)\)/);
});

test('buildProfileSqlForBigQuery returns null when no numeric columns', () => {
  const sql = buildProfileSqlForBigQuery({
    fqn: '`p.d.t`',
    numericColumns: [],
    dateColumn: { name: 'order_date' },
  });
  assert.equal(sql, null);
});

test('buildDateWindowWhere — bigquery DATE/TIMESTAMP/DATETIME dispatch', () => {
  assert.equal(
    buildDateWindowWhere({ dialect: 'bigquery', columnName: 'd', columnType: 'DATE', dayWindow: 30 }),
    '`d` >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)',
  );
  assert.equal(
    buildDateWindowWhere({ dialect: 'bigquery', columnName: 'ts', columnType: 'TIMESTAMP', dayWindow: 30 }),
    '`ts` >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)',
  );
  assert.equal(
    buildDateWindowWhere({ dialect: 'bigquery', columnName: 'dt', columnType: 'DATETIME', dayWindow: 30 }),
    '`dt` >= DATETIME_SUB(CURRENT_DATETIME(), INTERVAL 30 DAY)',
  );
});

test('buildDateWindowWhere — snowflake DATE/TIMESTAMP_NTZ dispatch', () => {
  assert.equal(
    buildDateWindowWhere({ dialect: 'snowflake', columnName: 'D', columnType: 'DATE', dayWindow: 30 }),
    '"D" >= DATEADD(day, -30, CURRENT_DATE())',
  );
  assert.equal(
    buildDateWindowWhere({ dialect: 'snowflake', columnName: 'TS', columnType: 'TIMESTAMP_NTZ', dayWindow: 30 }),
    '"TS" >= DATEADD(day, -30, CURRENT_TIMESTAMP())',
  );
});

test('buildDateWindowWhere — defaults to date-typed clause when type missing', () => {
  assert.equal(
    buildDateWindowWhere({ dialect: 'bigquery', columnName: 'd', dayWindow: 30 }),
    '`d` >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)',
  );
});

// =====================================================================
// prioritizeColumnsForDdl
// =====================================================================

test('prioritizeColumnsForDdl puts structural columns first', () => {
  // Bug from 2026-04-30 user test: 300+ column tables overflow Pinecone's
  // 39 KB per-string-field metadata budget at ingest time. The DDL gets
  // truncated from the tail. If structural columns (date / id / name /
  // status / type / channel / source / currency) happen to live in the
  // tail, the compiler's filterColumns can't include them — they're gone.
  //
  // Pre-sort at ingest so structural cols always survive truncation.
  const cols = [
    { name: "amount_facebook_ads", type: "NUMBER", samples: ["sum=100"] },
    { name: "user_id",             type: "STRING" },
    { name: "spend_meta",          type: "NUMBER" },
    { name: "order_date",          type: "DATE" },
    { name: "channel",             type: "STRING" },
  ];
  const out = prioritizeColumnsForDdl(cols);
  // date / id / channel are structural; should come first (in any order
  // among structural; we don't lock the within-group ordering)
  const structuralPositions = ["order_date", "user_id", "channel"].map(
    (n) => out.findIndex((c) => c.name === n),
  );
  const nonStructuralPositions = ["amount_facebook_ads", "spend_meta"].map(
    (n) => out.findIndex((c) => c.name === n),
  );
  for (const sp of structuralPositions) {
    for (const nsp of nonStructuralPositions) {
      assert.ok(sp < nsp, `structural col at ${sp} should precede non-structural at ${nsp}`);
    }
  }
});

test('prioritizeColumnsForDdl puts data-having (samples) before sample-less among non-structural', () => {
  const cols = [
    { name: "rare_unused_col",  type: "NUMBER" },
    { name: "amount",           type: "NUMBER", samples: ["sum=100", "max=50"] },
    { name: "another_unused",   type: "NUMBER" },
    { name: "qty",              type: "NUMBER", samples: ["sum=10"] },
  ];
  const out = prioritizeColumnsForDdl(cols);
  const amount = out.findIndex((c) => c.name === "amount");
  const qty = out.findIndex((c) => c.name === "qty");
  const unused1 = out.findIndex((c) => c.name === "rare_unused_col");
  const unused2 = out.findIndex((c) => c.name === "another_unused");
  assert.ok(amount < unused1 && amount < unused2);
  assert.ok(qty < unused1 && qty < unused2);
});

test('prioritizeColumnsForDdl is stable within each priority group', () => {
  // Same priority -> preserve original order (so deterministic output).
  const cols = [
    { name: "structural_a", type: "DATE" },
    { name: "structural_b", type: "DATE" },
    { name: "structural_c", type: "DATE" },
  ];
  const out = prioritizeColumnsForDdl(cols);
  assert.deepEqual(out.map((c) => c.name), ["structural_a", "structural_b", "structural_c"]);
});

test('prioritizeColumnsForDdl returns empty array for empty input', () => {
  assert.deepEqual(prioritizeColumnsForDdl([]), []);
});

// =======================================================================
// compileSQLWithClient — dependency-injected, gpt-5.4 default, CH refusal
// =======================================================================

function mockOpenAI(reply) {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        create: async (params) => {
          calls.push(params);
          return {
            choices: [{
              message: { content: reply },
              finish_reason: 'stop',
            }],
          };
        },
      },
    },
  };
}

test('compileSQLWithClient calls OpenAI with gpt-5.4 by default', async () => {
  const openai = mockOpenAI('SELECT 1');
  const matches = [{ id: 'db.s.t', kind: 'BASE TABLE', ddl: 'Table: db.s.t\n  - a (NUMBER)' }];
  const sql = await compileSQLWithClient({
    openai,
    question: 'how many?',
    matches,
    dialect: 'bigquery',
  });
  assert.equal(sql, 'SELECT 1');
  assert.equal(openai.calls[0].model, 'gpt-5.4');
});

test('compileSQLWithClient strips ```sql fences from output', async () => {
  const openai = mockOpenAI('```sql\nSELECT 1\n```');
  const sql = await compileSQLWithClient({
    openai,
    question: 'q',
    matches: [{ id: 'db.s.t', kind: 'BASE TABLE', ddl: 'Table: db.s.t\n  - a (NUMBER)' }],
    dialect: 'bigquery',
  });
  assert.equal(sql, 'SELECT 1');
});

test('compileSQLWithClient throws on ClickHouse dialect', async () => {
  const openai = mockOpenAI('irrelevant');
  await assert.rejects(
    () => compileSQLWithClient({
      openai,
      question: 'q',
      matches: [],
      dialect: 'clickhouse',
    }),
    (err) => err.message === CLICKHOUSE_REFUSAL_ERROR,
  );
  assert.equal(openai.calls.length, 0, 'should refuse before calling OpenAI');
});

test('compileSQLWithClient throws ERROR: prefix as Error', async () => {
  const openai = mockOpenAI('ERROR: cannot answer with provided tables');
  await assert.rejects(
    () => compileSQLWithClient({
      openai,
      question: 'q',
      matches: [{ id: 'db.s.t', kind: 'BASE TABLE', ddl: 'Table: db.s.t\n  - a (NUMBER)' }],
      dialect: 'bigquery',
    }),
    /ERROR:/,
  );
});

test('compileSQLWithClient supports custom chatModel', async () => {
  const openai = mockOpenAI('SELECT 1');
  await compileSQLWithClient({
    openai,
    question: 'q',
    matches: [{ id: 'db.s.t', kind: 'BASE TABLE', ddl: 'Table: db.s.t\n  - a (NUMBER)' }],
    dialect: 'bigquery',
    chatModel: 'gpt-5.4-mini',
  });
  assert.equal(openai.calls[0].model, 'gpt-5.4-mini');
});

test('recompileSQLWithClient feeds failed SQL + error back to model', async () => {
  const openai = mockOpenAI('SELECT 2');
  const sql = await recompileSQLWithClient({
    openai,
    question: 'q',
    matches: [{ id: 'db.s.t', kind: 'BASE TABLE', ddl: 'Table: db.s.t\n  - a (NUMBER)' }],
    failedSql: 'SELECT bad',
    errorMessage: 'column not found',
    dialect: 'bigquery',
  });
  assert.equal(sql, 'SELECT 2');
  const msgs = openai.calls[0].messages;
  // expect the failed SQL appears as an assistant turn and error message in user turn
  assert.equal(msgs.some(m => m.role === 'assistant' && m.content === 'SELECT bad'), true);
  assert.equal(msgs.some(m => m.role === 'user' && m.content.includes('column not found')), true);
});

test('recompileSQLWithClient refuses ClickHouse', async () => {
  const openai = mockOpenAI('SELECT 1');
  await assert.rejects(
    () => recompileSQLWithClient({
      openai,
      question: 'q',
      matches: [],
      failedSql: 'SELECT bad',
      errorMessage: 'oops',
      dialect: 'clickhouse',
    }),
    (err) => err.message === CLICKHOUSE_REFUSAL_ERROR,
  );
});

// =======================================================================
// searchOntologyWithClients — dependency-injected
// =======================================================================

function mockEmbeddingsClient(vectors) {
  return {
    embeddings: {
      create: async ({ input }) => ({
        data: (Array.isArray(input) ? input : [input]).map((_, i) => ({
          embedding: vectors[i] ?? new Array(1536).fill(0),
        })),
      }),
    },
  };
}

function mockPineconeIndex(matches) {
  let calls = [];
  return {
    calls,
    namespace: () => ({
      query: async (req) => {
        calls.push(req);
        // Return all matches when no filter; filter by metadata.schema when filter is provided
        if (req.filter && req.filter.schema?.$eq) {
          return { matches: matches.filter(m => m.metadata?.schema === req.filter.schema.$eq) };
        }
        return { matches };
      },
    }),
  };
}

test('searchOntologyWithClients returns sorted results with keyword boost', async () => {
  const matches = [
    { id: 'db.public.foo', score: 0.7, metadata: { database: 'db', schema: 'public', table: 'foo', kind: 'BASE TABLE', ddl: 'X' } },
    { id: 'db.public.bar_revenue', score: 0.6, metadata: { database: 'db', schema: 'public', table: 'bar_revenue', kind: 'BASE TABLE', ddl: 'Y' } },
  ];
  const idx = mockPineconeIndex(matches);
  const pinecone = { index: () => idx };
  const openai = mockEmbeddingsClient([new Array(1536).fill(0.1)]);
  const out = await searchOntologyWithClients({
    pinecone, openai, indexName: 'i', namespace: 'n',
    query: 'revenue',
    topK: 5,
  });
  assert.equal(out.length, 2);
  // bar_revenue should win because of keyword boost
  assert.equal(out[0].id, 'db.public.bar_revenue');
});

test('searchOntologyWithClients respects custom topK', async () => {
  const matches = Array.from({ length: 10 }, (_, i) => ({
    id: `db.s.t${i}`, score: 0.5, metadata: { database: 'db', schema: 's', table: `t${i}`, kind: 'BASE TABLE', ddl: '' },
  }));
  const idx = mockPineconeIndex(matches);
  const pinecone = { index: () => idx };
  const openai = mockEmbeddingsClient([new Array(1536).fill(0)]);
  const out = await searchOntologyWithClients({
    pinecone, openai, indexName: 'i', namespace: 'n',
    query: 'something',
    topK: 3,
  });
  assert.equal(out.length, 3);
});
