import OpenAI from 'openai';
import { getConfig } from './config.js';

const MAX_COLUMNS_PER_TABLE = 30;

export const DIALECT_HINTS = {
  snowflake: `TARGET DIALECT: Snowflake SQL
- Use fully qualified names: DATABASE.SCHEMA.TABLE_NAME
- Use DATEADD, DATEDIFF, CURRENT_DATE(), CURRENT_TIMESTAMP()
- Use :: for casting (e.g. col::DATE)
- Double-quote identifiers only when case-sensitive`,

  bigquery: `TARGET DIALECT: Google BigQuery (Standard SQL)
- Use fully qualified names: \`project.dataset.table\` (backtick-quoted)
- Use DATE_ADD, DATE_SUB, DATE_DIFF, CURRENT_DATE(), CURRENT_TIMESTAMP()
- Use CAST(col AS TYPE) for casting
- Use STRUCT and ARRAY types natively
- Use EXCEPT/REPLACE in SELECT * expressions where useful`,
};

export const SYSTEM_PROMPT = (dialect) => `You are a SQL expert and semantic compiler. You translate natural language questions into precise, executable SQL queries.

You receive an ONTOLOGY CONTEXT — table definitions from a data warehouse. Each table has a STRICT column list. You may ONLY use columns listed under that specific table.

${DIALECT_HINTS[dialect] || ''}

CRITICAL — COLUMN-TABLE BINDING:
- Each table lists ONLY its own columns. A column listed under Table A DOES NOT EXIST in Table B.
- In a SELECT ... FROM tableX, every column in that SELECT must be from tableX's column list.
- If you need data from multiple tables, use JOIN (on shared key columns) or UNION ALL (for combining similar rows). NEVER put a column from one table into a SELECT from a different table.
- Copy column names EXACTLY as listed. Character-for-character. NEVER abbreviate, invent, or paraphrase.

SAMPLE DATA:
- Some columns include sample values (e.g. "e.g. 142.50, 87.30"). Use these to understand what each column represents.
- Columns without sample values may be mostly NULL — prefer columns that show sample data.
- Use sample values to infer units, data types, and what the column measures (counts vs. dollar amounts vs. IDs, etc.).
- When sample data shows the SAME date repeated (e.g. "2026-03-30, 2026-03-30, 2026-03-30"), the table has multiple rows per date. You MUST use GROUP BY date with SUM/COUNT/AVG when computing per-day metrics.

RULES:
1. Use ONLY the tables and columns present in the ontology context.
2. Always use fully qualified table names.
3. Generate ONLY SELECT statements — never mutate data.
4. Before writing SQL, mentally verify: for every column reference, is it listed under the table in the FROM/JOIN clause?
5. Infer JOIN conditions from matching column names, types, and naming conventions.
6. When computing metrics (ROAS, CPA, CTR, totals, averages), ALWAYS use SUM/COUNT/AVG with GROUP BY — raw tables almost always have multiple rows per date/entity.
7. Format the SQL cleanly.

OUTPUT:
Return ONLY the raw SQL query — no markdown fences, no explanation.
If the question cannot be answered with the provided tables, start your response with "ERROR:" and explain what is missing.`;

export function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(t => t.length > 2);
}

export function stem(token) {
  if (token.length > 4 && token.endsWith('s')) return token.slice(0, -1);
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2);
  return token;
}

export function expandQueryTokens(tokens) {
  const expanded = new Set();
  for (const t of tokens) {
    expanded.add(t);
    expanded.add(stem(t));
  }
  return expanded;
}

export function scoreColumn(colName, queryTokens) {
  const colTokens = tokenize(colName);
  let score = 0;
  for (const ct of colTokens) {
    if (queryTokens.has(ct) || queryTokens.has(stem(ct))) score++;
  }
  return score;
}

export function isStructuralColumn(colName, colType) {
  const upper = colType.toUpperCase();
  if (['DATE', 'TIMESTAMP', 'DATETIME', 'TIMESTAMP_NTZ', 'TIMESTAMP_LTZ', 'TIMESTAMP_TZ'].includes(upper)) return true;
  const lc = colName.toLowerCase();
  if (lc.endsWith('_id') || lc === 'id' || lc.endsWith('_name') || lc === 'name') return true;
  if (lc === 'status' || lc === 'type' || lc === 'channel' || lc === 'source' || lc === 'currency') return true;
  return false;
}

export function parseDataVolume(line) {
  const nzr = line.match(/nonzero_rows=(\d+)/);
  if (nzr) return Number(nzr[1]);
  const nnr = line.match(/nonnull_rows=(\d+)/);
  if (nnr) return Number(nnr[1]);
  return 0;
}

export function filterColumns(ddl, queryTokens) {
  const lines = ddl.split('\n');
  const header = lines.filter(l => !l.match(/^\s+-\s/));
  const colLines = lines.filter(l => l.match(/^\s+-\s/));

  if (colLines.length <= MAX_COLUMNS_PER_TABLE) return ddl;

  const parsed = colLines.map(line => {
    const nameMatch = line.match(/^\s+-\s+(\S+)\s+\(([^)]+)\)/);
    const name = nameMatch?.[1] || '';
    const type = nameMatch?.[2]?.split(',')[0]?.trim() || '';
    const structural = isStructuralColumn(name, type);
    const isNumCol = /nonzero_rows=\d/.test(line);
    const hasData = isNumCol || /nonnull_rows=\d/.test(line);
    const keywordScore = scoreColumn(name, queryTokens) + (hasData ? 3 : 0);
    const dataVolume = parseDataVolume(line);
    return { line, name, structural, keywordScore, dataVolume, isNumCol };
  });

  const structural = parsed.filter(s => s.structural);
  const nonStructural = parsed.filter(s => !s.structural);

  const KEYWORD_SLOTS = 15;
  const remaining = Math.max(MAX_COLUMNS_PER_TABLE - structural.length - KEYWORD_SLOTS, 0);
  const NUM_DATA_SLOTS = Math.ceil(remaining * 0.7);
  const STR_DATA_SLOTS = remaining - NUM_DATA_SLOTS;

  const byKeyword = [...nonStructural].sort((a, b) => b.keywordScore - a.keywordScore);
  const keywordPicks = byKeyword.slice(0, Math.max(KEYWORD_SLOTS, 0));
  const keywordNames = new Set(keywordPicks.map(p => p.name));

  const leftover = nonStructural.filter(p => !keywordNames.has(p.name));
  const numLeftover = leftover.filter(p => p.isNumCol).sort((a, b) => b.dataVolume - a.dataVolume);
  const strLeftover = leftover.filter(p => !p.isNumCol).sort((a, b) => b.dataVolume - a.dataVolume);

  const dataPicks = [
    ...numLeftover.slice(0, NUM_DATA_SLOTS),
    ...strLeftover.slice(0, STR_DATA_SLOTS),
  ];

  const selected = [...structural, ...keywordPicks, ...dataPicks];
  const omitted = colLines.length - selected.length;

  const filteredDDL = [...header, ...selected.map(s => s.line)].join('\n');
  const note = omitted > 0 ? `\n  (${omitted} less-relevant columns omitted)` : '';
  return filteredDDL + note;
}

export function buildTableContext(match, queryTokens) {
  const filteredDDL = filterColumns(match.ddl, queryTokens);
  const cols = filteredDDL.split('\n').filter(l => l.match(/^\s+-\s/));
  const note = filteredDDL.includes('omitted') ? filteredDDL.split('\n').pop() : '';
  const header = `TABLE: ${match.id} [${match.kind}] — ${cols.length} columns available`;
  return `${header}\nVALID COLUMNS (ONLY these exist in this table):\n${cols.join('\n')}${note ? '\n' + note : ''}`;
}

export function buildCompilerContext(question, ontologyMatches) {
  const queryTokens = expandQueryTokens(tokenize(question));
  return ontologyMatches.map(m => buildTableContext(m, queryTokens)).join('\n\n');
}

export async function compileSQL(question, ontologyMatches) {
  const cfg    = getConfig();
  const openai = new OpenAI({ apiKey: cfg.openai.apiKey });

  const context = buildCompilerContext(question, ontologyMatches);
  const userMessage = `ONTOLOGY CONTEXT:\n\n${context}\n\nQUESTION:\n${question}`;

  const resp = await openai.chat.completions.create({
    model:    cfg.openai.chatModel,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT(cfg.warehouseType) },
      { role: 'user',   content: userMessage },
    ],
    temperature: 0,
    max_completion_tokens: 8192,
  });

  const choice = resp.choices[0];
  if (choice.finish_reason === 'length') {
    throw new Error('Compiler output truncated — query too complex for token budget.');
  }

  let sql = (choice.message.content || '').trim();
  sql = sql.replace(/^```(?:sql)?\s*\n?/i, '').replace(/\n?```\s*$/, '');

  if (sql.startsWith('ERROR:')) {
    throw new Error(sql);
  }

  return sql;
}

export async function recompileSQL(question, ontologyMatches, failedSQL, errorMessage) {
  const cfg    = getConfig();
  const openai = new OpenAI({ apiKey: cfg.openai.apiKey });

  const context = buildCompilerContext(question, ontologyMatches);
  const userMessage = `ONTOLOGY CONTEXT:\n\n${context}\n\nQUESTION:\n${question}`;

  const errorFeedback = `The previous SQL failed with this error:\n\nSQL:\n${failedSQL}\n\nERROR:\n${errorMessage}\n\nFix the SQL. Remember: each column ONLY exists in the table it is listed under. Do not use a column from one table in a SELECT from a different table. Return ONLY the corrected SQL.`;

  const resp = await openai.chat.completions.create({
    model:    cfg.openai.chatModel,
    messages: [
      { role: 'system',    content: SYSTEM_PROMPT(cfg.warehouseType) },
      { role: 'user',      content: userMessage },
      { role: 'assistant', content: failedSQL },
      { role: 'user',      content: errorFeedback },
    ],
    temperature: 0,
    max_completion_tokens: 8192,
  });

  const choice = resp.choices[0];
  if (choice.finish_reason === 'length') {
    throw new Error('Compiler output truncated on retry.');
  }

  let sql = (choice.message.content || '').trim();
  sql = sql.replace(/^```(?:sql)?\s*\n?/i, '').replace(/\n?```\s*$/, '');

  if (sql.startsWith('ERROR:')) {
    throw new Error(sql);
  }

  return sql;
}
