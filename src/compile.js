import OpenAI from 'openai';
import { getConfig } from './config.js';

const DIALECT_HINTS = {
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

const SYSTEM_PROMPT = (dialect) => `You are a SQL expert and semantic compiler. You translate natural language questions into precise, executable SQL queries.

You receive an ONTOLOGY CONTEXT — table definitions from a data warehouse. Each table has a STRICT column list. You may ONLY use columns listed under that specific table.

${DIALECT_HINTS[dialect] || ''}

CRITICAL — COLUMN SCOPING:
- Each table section lists its EXACT columns. A column from Table A MUST NOT be used with Table B.
- Copy column names EXACTLY as listed. Character-for-character. NEVER abbreviate, invent, or paraphrase.
- When multiple columns look similar, pick the one whose name best matches the user's intent.
- If unsure, prefer the most specific column name (e.g. "Website_Purchases_Conversion_Value__X" over "Conversion_Value__X" for website purchase revenue).

RULES:
1. Use ONLY the tables and columns present in the ontology context.
2. Always use fully qualified table names.
3. Generate ONLY SELECT statements — never mutate data.
4. Infer JOIN conditions from matching column names, types, and naming conventions.
5. Apply appropriate aggregations, filters, GROUP BY, and ORDER BY based on the question.
6. When relationships are ambiguous, prefer joins on identically named columns.
7. Format the SQL cleanly.

OUTPUT:
Return ONLY the raw SQL query — no markdown fences, no explanation.
If the question cannot be answered with the provided tables, start your response with "ERROR:" and explain what is missing.`;

function buildTableContext(match) {
  const header = `TABLE: ${match.id} [${match.kind}, relevance: ${match.score.toFixed(3)}]`;
  const cols = match.ddl.split('\n').filter(l => l.match(/^\s+-\s/));
  return `${header}\nVALID COLUMNS (use ONLY these with this table):\n${cols.join('\n')}`;
}

function extractColumnsPerTable(matches) {
  const map = new Map();
  for (const m of matches) {
    const cols = new Set();
    for (const line of m.ddl.split('\n')) {
      const hit = line.match(/^\s+-\s+(\S+)\s+\(/);
      if (hit) cols.add(hit[1]);
    }
    map.set(m.id, cols);
  }
  return map;
}

export async function compileSQL(question, ontologyMatches) {
  const cfg    = getConfig();
  const openai = new OpenAI({ apiKey: cfg.openai.apiKey });

  const context = ontologyMatches.map(buildTableContext).join('\n\n');
  const userMessage = `ONTOLOGY CONTEXT:\n\n${context}\n\nQUESTION:\n${question}`;

  const resp = await openai.chat.completions.create({
    model:    cfg.openai.chatModel,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT(cfg.warehouseType) },
      { role: 'user',   content: userMessage },
    ],
    temperature: 0,
    max_completion_tokens: 2048,
  });

  let sql = resp.choices[0].message.content.trim();
  sql = sql.replace(/^```(?:sql)?\s*\n?/i, '').replace(/\n?```\s*$/, '');

  if (sql.startsWith('ERROR:')) {
    throw new Error(sql);
  }

  return sql;
}
