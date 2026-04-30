// Programmatic API for embedding semantic-compiler into other systems.
//
// All functions are dependency-injected: callers provide their own OpenAI /
// Pinecone clients, warehouse handles, and dialect. There is no env / config
// dependency in this module — `getConfig()` is only used by the standalone
// CLI in src/index.js.
//
// This is the public surface consumed by labs-mcp-gamma's marshal pipeline
// (ingest worker) and the marshal MCP tool (request-time).

import {
  buildCompilerContext,
  filterColumns,
  tokenize,
  stem,
  expandQueryTokens,
  scoreColumn,
  isStructuralColumn,
  parseDataVolume,
  buildTableContext,
  SYSTEM_PROMPT,
  DIALECT_HINTS,
} from './compile.js';

import { tableToText, tableToFullDDL } from './embed.js';

// =====================================================================
// Public re-exports of pure helpers
// =====================================================================
export {
  buildCompilerContext,
  filterColumns,
  tokenize,
  stem,
  expandQueryTokens,
  scoreColumn,
  isStructuralColumn,
  parseDataVolume,
  buildTableContext,
};

export const tableToEmbedText = tableToText;
export { tableToFullDDL };

// =====================================================================
// Constants
// =====================================================================
export const SUPPORTED_DIALECTS = ['bigquery', 'snowflake'];
export const DEFAULT_CHAT_MODEL = 'gpt-5.4';
export const DEFAULT_EMBED_MODEL = 'text-embedding-3-small';
export const DEFAULT_EMBED_DIMENSIONS = 1536;
export const CLICKHOUSE_REFUSAL_ERROR =
  'ClickHouse is not supported by the marshal compiler. Use BigQuery or Snowflake.';

function assertDialectSupported(dialect) {
  if (dialect === 'clickhouse') {
    throw new Error(CLICKHOUSE_REFUSAL_ERROR);
  }
  if (!SUPPORTED_DIALECTS.includes(dialect)) {
    throw new Error(`Unsupported dialect: "${dialect}". Use one of: ${SUPPORTED_DIALECTS.join(', ')}`);
  }
}

// =====================================================================
// Compile (DI variant of compile.js#compileSQL)
// =====================================================================

function stripCodeFences(s) {
  return s.replace(/^```(?:sql)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
}

/**
 * Compile a natural-language question into dialect-correct SQL.
 *
 * @param {object} args
 * @param {object} args.openai - OpenAI client with chat.completions.create
 * @param {string} args.question - NL question
 * @param {Array} args.matches - Ontology matches (id, kind, ddl)
 * @param {'bigquery'|'snowflake'} args.dialect
 * @param {string} [args.chatModel='gpt-5.4']
 * @param {number} [args.maxTokens=8192]
 * @returns {Promise<string>} SQL
 */
export async function compileSQLWithClient({
  openai,
  question,
  matches,
  dialect,
  chatModel = DEFAULT_CHAT_MODEL,
  maxTokens = 8192,
}) {
  assertDialectSupported(dialect);

  const context = buildCompilerContext(question, matches);
  const userMessage = `ONTOLOGY CONTEXT:\n\n${context}\n\nQUESTION:\n${question}`;

  const resp = await openai.chat.completions.create({
    model: chatModel,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT(dialect) },
      { role: 'user', content: userMessage },
    ],
    temperature: 0,
    max_completion_tokens: maxTokens,
  });

  const choice = resp.choices[0];
  if (choice.finish_reason === 'length') {
    throw new Error('Compiler output truncated — query too complex for token budget.');
  }

  let sql = stripCodeFences((choice.message.content || '').trim());

  if (sql.startsWith('ERROR:')) {
    throw new Error(sql);
  }

  return sql;
}

/**
 * Recompile after an execution error. Feeds the failed SQL + error message
 * back to the model. Caller is responsible for redacting `errorMessage` for
 * scoped users (info-leak oracle, see SECURITY.md Round 2 #9 in MCP repo).
 */
export async function recompileSQLWithClient({
  openai,
  question,
  matches,
  failedSql,
  errorMessage,
  dialect,
  chatModel = DEFAULT_CHAT_MODEL,
  maxTokens = 8192,
}) {
  assertDialectSupported(dialect);

  const context = buildCompilerContext(question, matches);
  const userMessage = `ONTOLOGY CONTEXT:\n\n${context}\n\nQUESTION:\n${question}`;

  const errorFeedback =
    `The previous SQL failed with this error:\n\nSQL:\n${failedSql}\n\nERROR:\n${errorMessage}\n\n` +
    `Fix the SQL. Remember: each column ONLY exists in the table it is listed under. ` +
    `Do not use a column from one table in a SELECT from a different table. Return ONLY the corrected SQL.`;

  const resp = await openai.chat.completions.create({
    model: chatModel,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT(dialect) },
      { role: 'user', content: userMessage },
      { role: 'assistant', content: failedSql },
      { role: 'user', content: errorFeedback },
    ],
    temperature: 0,
    max_completion_tokens: maxTokens,
  });

  const choice = resp.choices[0];
  if (choice.finish_reason === 'length') {
    throw new Error('Compiler output truncated on retry.');
  }

  let sql = stripCodeFences((choice.message.content || '').trim());

  if (sql.startsWith('ERROR:')) {
    throw new Error(sql);
  }

  return sql;
}

// =====================================================================
// Search (DI variant of search.js#searchOntology)
// =====================================================================

const KEYWORD_BOOST = 0.15;
const DATASET_SCORE_FLOOR = 0.40;
const FETCH_MULTIPLIER = 3;

function searchTokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(t => t.length > 2);
}

function keywordBoost(match, queryTokens) {
  const haystack = [match.database, match.schema, match.table]
    .join(' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ');

  let hits = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) hits++;
  }
  return hits > 0 ? (hits / queryTokens.length) * KEYWORD_BOOST : 0;
}

function detectDatasets(queryTokens, semanticMatches) {
  const knownSchemas = new Set();
  for (const m of semanticMatches) {
    if (m.metadata?.schema) knownSchemas.add(m.metadata.schema);
  }

  const matched = new Set();
  for (const schema of knownSchemas) {
    const schemaTokens = schema.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/);
    for (const qt of queryTokens) {
      for (const st of schemaTokens) {
        if (st.includes(qt) || qt.includes(st)) {
          matched.add(schema);
        }
      }
    }
  }
  return [...matched];
}

function pineconeMatchToResult(m) {
  return {
    id: m.id,
    score: m.score,
    database: m.metadata?.database ?? m.database,
    schema: m.metadata?.schema ?? m.schema,
    table: m.metadata?.table ?? m.table,
    kind: m.metadata?.kind ?? m.kind ?? "",
    ddl: m.metadata?.ddl ?? m.ddl ?? "",
    metadata: m.metadata ?? {},
  };
}

/**
 * Semantic + keyword + dataset-aware search over a Pinecone index/namespace.
 *
 * @param {object} args
 * @param {object} args.pinecone - Pinecone client (pinecone.index(name).namespace(ns).query(...))
 * @param {object} args.openai   - OpenAI client (openai.embeddings.create)
 * @param {string} args.indexName
 * @param {string} args.namespace
 * @param {string} args.query
 * @param {number} [args.topK=5]
 * @param {string} [args.embedModel='text-embedding-3-small']
 * @param {Record<string,unknown>} [args.filter] - Optional metadata filter (e.g. scope filter)
 * @returns {Promise<Array>}
 */
export async function searchOntologyWithClients({
  pinecone,
  openai,
  indexName,
  namespace,
  query,
  topK = 5,
  embedModel = DEFAULT_EMBED_MODEL,
  filter,
}) {
  const idx = pinecone.index(indexName).namespace(namespace);

  const resp = await openai.embeddings.create({
    model: embedModel,
    input: query,
  });
  const vector = resp.data[0].embedding;

  const semanticReq = {
    vector,
    topK: topK * FETCH_MULTIPLIER,
    includeMetadata: true,
  };
  if (filter) semanticReq.filter = filter;

  const semanticResults = await idx.query(semanticReq);

  const queryTokens = searchTokenize(query);
  const matches = semanticResults.matches || [];

  const detectedDatasets = detectDatasets(queryTokens, matches);

  let datasetMatches = [];
  if (detectedDatasets.length > 0) {
    const fetches = detectedDatasets.map(schema => {
      const dsReq = { vector, topK: 20, filter: { schema: { $eq: schema } }, includeMetadata: true };
      if (filter) dsReq.filter = { ...filter, schema: { $eq: schema } };
      return idx.query(dsReq);
    });
    const dsResults = await Promise.all(fetches);
    for (const res of dsResults) {
      datasetMatches.push(...(res.matches || []));
    }
  }

  const seen = new Map();

  for (const m of matches) {
    const r = pineconeMatchToResult(m);
    r.score = m.score + keywordBoost(
      { database: r.database, schema: r.schema, table: r.table }, queryTokens,
    );
    seen.set(r.id, r);
  }

  for (const m of datasetMatches) {
    if (seen.has(m.id)) continue;
    const r = pineconeMatchToResult(m);
    r.score = Math.max(m.score, DATASET_SCORE_FLOOR) + keywordBoost(
      { database: r.database, schema: r.schema, table: r.table }, queryTokens,
    );
    seen.set(r.id, r);
  }

  const all = [...seen.values()];
  all.sort((a, b) => b.score - a.score);

  const adjustedTopK = detectedDatasets.length > 0
    ? Math.max(topK, topK + datasetMatches.filter(m => !matches.find(s => s.id === m.id)).length)
    : topK;

  return all.slice(0, Math.min(adjustedTopK, topK + 5));
}

// =====================================================================
// Profile SQL builders (pure, dialect-aware)
// =====================================================================
//
// These return parameterless SQL strings. Caller dispatches them through
// their own warehouse client (e.g. MCP's BigQuery / Snowflake connectors)
// inside the marshal ingest pipeline. Returns null when there are no
// numeric columns to profile.

/**
 * Build a dialect-aware "<col> >= <now> - <dayWindow> days" WHERE expression.
 *
 * BigQuery doesn't auto-coerce DATE and TIMESTAMP, so the clause must use
 * the matching `*_SUB(CURRENT_*())` pair for the column's type. Snowflake
 * is more permissive but using the matching `CURRENT_TIMESTAMP()` for
 * TIMESTAMP-family columns avoids implicit casts.
 *
 * Returns the bare expression (no leading 'WHERE'). Caller composes.
 */
export function buildDateWindowWhere({ dialect, columnName, columnType, dayWindow = 30 }) {
  const isTimestamp = !!columnType && /^(TIMESTAMP|TIMESTAMP_NTZ|TIMESTAMP_LTZ|TIMESTAMP_TZ)$/i.test(columnType);
  const isDatetime = !!columnType && /^DATETIME$/i.test(columnType);

  if (dialect === 'bigquery') {
    const quoted = `\`${columnName}\``;
    if (isTimestamp) return `${quoted} >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${dayWindow} DAY)`;
    if (isDatetime) return `${quoted} >= DATETIME_SUB(CURRENT_DATETIME(), INTERVAL ${dayWindow} DAY)`;
    // DATE (or unspecified type — back-compat with original behaviour)
    return `${quoted} >= DATE_SUB(CURRENT_DATE(), INTERVAL ${dayWindow} DAY)`;
  }

  // snowflake
  const quoted = `"${columnName}"`;
  const nowFn = (isTimestamp || isDatetime) ? 'CURRENT_TIMESTAMP()' : 'CURRENT_DATE()';
  return `${quoted} >= DATEADD(day, -${dayWindow}, ${nowFn})`;
}

/**
 * Build the BigQuery profiling SQL: SUM / COUNT(!= 0) / MAX per column,
 * scoped to the last `dayWindow` days when a date column is present.
 */
export function buildProfileSqlForBigQuery({ fqn, numericColumns, dateColumn, dayWindow = 30 }) {
  if (!numericColumns || numericColumns.length === 0) return null;

  const exprs = numericColumns.flatMap(c => [
    `SUM(\`${c.name}\`) AS \`${c.name}__sum\``,
    `COUNTIF(\`${c.name}\` != 0 AND \`${c.name}\` IS NOT NULL) AS \`${c.name}__nnz\``,
    `MAX(\`${c.name}\`) AS \`${c.name}__max\``,
  ]).join(', ');

  const where = dateColumn
    ? ` WHERE ${buildDateWindowWhere({ dialect: 'bigquery', columnName: dateColumn.name, columnType: dateColumn.type, dayWindow })}`
    : '';

  return `SELECT ${exprs} FROM ${fqn}${where}`;
}

/**
 * Build the Snowflake profiling SQL: SUM / COUNT(CASE..) / MAX per column,
 * scoped to the last `dayWindow` days when a date column is present.
 */
export function buildProfileSqlForSnowflake({ fqn, numericColumns, dateColumn, dayWindow = 30 }) {
  if (!numericColumns || numericColumns.length === 0) return null;

  const exprs = numericColumns.flatMap(c => [
    `SUM("${c.name}") AS "${c.name}__sum"`,
    `COUNT(CASE WHEN "${c.name}" != 0 AND "${c.name}" IS NOT NULL THEN 1 END) AS "${c.name}__nnz"`,
    `MAX("${c.name}") AS "${c.name}__max"`,
  ]).join(', ');

  const where = dateColumn
    ? ` WHERE ${buildDateWindowWhere({ dialect: 'snowflake', columnName: dateColumn.name, columnType: dateColumn.type, dayWindow })}`
    : '';

  return `SELECT ${exprs} FROM ${fqn}${where}`;
}

// =====================================================================
// Helpers for ingest column-type classification (re-exported pure)
// =====================================================================

export function isNumericType(type) {
  return /NUMBER|FLOAT|REAL|DECIMAL|INT|DOUBLE|NUMERIC|BIGNUMERIC|INTEGER/i.test(type);
}

export function isStringLikeType(type) {
  return /VARCHAR|TEXT|STRING/i.test(type);
}

export function findDateColumn(columns) {
  return columns.find(c =>
    /^(DATE|TIMESTAMP|DATETIME|TIMESTAMP_NTZ|TIMESTAMP_LTZ|TIMESTAMP_TZ)$/i.test(c.type)
  );
}

// =====================================================================
// Column prioritization (for ingest-time DDL ordering)
// =====================================================================
//
// Pinecone caps a single metadata string field at ~39 KB. Wide tables
// (300+ cols) can overflow that even after the OG `tableToFullDDL` cap
// kicks in, and naive truncation drops whatever happens to live in the
// tail — possibly the columns the LLM compiler needs most.
//
// Sort columns at ingest time so the highest-signal ones come first:
//
//   1. structural (date / id / name / status / type / channel / source /
//      currency) — these are filterColumns()'s "always include" set
//   2. data-having (have profile samples — proxies for "actively used")
//   3. everything else
//
// Within each group, original input order is preserved (stable sort).

export function prioritizeColumnsForDdl(columns) {
  const tagged = columns.map((c, originalIndex) => {
    const structural = isStructuralColumn(c.name, c.type);
    const hasSamples = !!(c.samples && c.samples.length > 0);
    const tier = structural ? 0 : (hasSamples ? 1 : 2);
    return { c, tier, originalIndex };
  });
  tagged.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    return a.originalIndex - b.originalIndex;
  });
  return tagged.map((t) => t.c);
}
