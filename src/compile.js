import OpenAI from 'openai';
import { getConfig } from './config.js';

const SYSTEM_PROMPT = `You are a Snowflake SQL expert and semantic compiler. You translate natural language questions into precise, executable Snowflake SQL queries.

You receive an ONTOLOGY CONTEXT — a set of table definitions retrieved from a data warehouse via semantic search. These are the most relevant tables for the user's question.

RULES:
1. Use ONLY the tables and columns present in the ontology context.
2. Always use fully qualified names: DATABASE.SCHEMA.TABLE_NAME.
3. Generate ONLY SELECT statements — never mutate data.
4. Infer JOIN conditions from matching column names, types, and naming conventions.
5. Apply appropriate aggregations, filters, GROUP BY, and ORDER BY based on the question.
6. When relationships are ambiguous, prefer joins on identically named columns.
7. Format the SQL cleanly.

OUTPUT:
Return ONLY the raw SQL query — no markdown fences, no explanation.
If the question cannot be answered with the provided tables, start your response with "ERROR:" and explain what is missing.`;

export async function compileSQL(question, ontologyMatches) {
  const cfg    = getConfig();
  const openai = new OpenAI({ apiKey: cfg.openai.apiKey });

  const context = ontologyMatches
    .map((m, i) => `--- Match ${i + 1} (relevance: ${m.score.toFixed(3)}) ---\n${m.ddl}`)
    .join('\n\n');

  const userMessage = `ONTOLOGY CONTEXT:\n${context}\n\nQUESTION:\n${question}`;

  const resp = await openai.chat.completions.create({
    model:    cfg.openai.chatModel,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userMessage },
    ],
    temperature: 0,
    max_completion_tokens: 2048,
  });

  let sql = resp.choices[0].message.content.trim();

  sql = sql.replace(/^```(?:sql)?\s*\n?/i, '').replace(/\n?```\s*$/,'');

  if (sql.startsWith('ERROR:')) {
    throw new Error(sql);
  }

  return sql;
}
