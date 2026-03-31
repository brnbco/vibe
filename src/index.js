import { crawlTopology } from './crawl.js';
import { indexTopology } from './embed.js';
import { searchOntology } from './search.js';
import { compileSQL, recompileSQL, buildCompilerContext } from './compile.js';
import { executeSQL, formatResults } from './execute.js';

const [,, command, ...rest] = process.argv;
const question = rest.join(' ');

async function runCrawl() {
  console.log('\n⛏  Crawling warehouse topology…');
  const topology = await crawlTopology();
  return topology;
}

async function runIndex(topology) {
  console.log('\n📦 Embedding topology into Pinecone…');
  await indexTopology(topology ?? undefined);
}

async function runQuery(q) {
  if (!q) {
    console.error('Usage: node src/index.js query "your question here"');
    process.exit(1);
  }

  console.log(`\n🔍 Searching ontology for: "${q}"`);
  const matches = await searchOntology(q);

  if (matches.length === 0) {
    console.log('  ✗ No relevant tables found. Try re-crawling or re-indexing.');
    return;
  }

  console.log(`  found ${matches.length} relevant table(s):`);
  for (const m of matches) {
    console.log(`    ${m.id}  (score: ${m.score.toFixed(3)}, ${m.kind})`);
  }

  const compilerCtx = buildCompilerContext(q, matches);
  console.log('\n┌─── Compiler Context (filtered) ───');
  compilerCtx.split('\n').forEach(l => console.log(`│ ${l}`));
  console.log(`└───────────────────────────────────`);

  const MAX_RETRIES = 2;
  let sql = null;
  let results = null;
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt === 0) {
      console.log('\n🔧 Compiling SQL…');
      sql = await compileSQL(q, matches);
    } else {
      console.log(`\n🔧 Recompiling (attempt ${attempt + 1}/${MAX_RETRIES + 1}) — fixing: ${lastError}`);
      sql = await recompileSQL(q, matches, sql, lastError);
    }

    console.log(`\n┌─── Generated SQL ───`);
    console.log(sql.split('\n').map(l => `│ ${l}`).join('\n'));
    console.log(`└─────────────────────`);

    console.log('\n⚡ Executing…');
    try {
      results = await executeSQL(sql);
      break;
    } catch (err) {
      lastError = err.message;
      if (attempt === MAX_RETRIES) throw err;
      console.log(`  ✗ ${lastError}`);
    }
  }

  if (results.rows.length > 0) {
    console.log('\n┌─── Raw row[0] ───');
    for (const [k, v] of Object.entries(results.rows[0])) {
      console.log(`│ ${k}: ${JSON.stringify(v)} (${typeof v})`);
    }
    console.log('└──────────────────');
  }

  console.log(`\n${formatResults(results)}`);
}

async function runPipeline(q) {
  const topology = await runCrawl();
  await runIndex(topology);
  await runQuery(q);
}

async function main() {
  switch (command) {
    case 'crawl':
      await runCrawl();
      break;
    case 'index':
      await runIndex();
      break;
    case 'query':
      await runQuery(question);
      break;
    case 'pipeline':
      await runPipeline(question);
      break;
    default:
      console.log(`
semantic-compiler — natural language → SQL (Snowflake / BigQuery)

Commands:
  crawl                          Discover warehouse topology and save locally
  index                          Embed topology into Pinecone vector DB
  query  "your question here"    Search ontology → compile SQL → execute
  pipeline "your question"       Full run: crawl → index → query

Setup:
  1. cp env.sample .env       (fill in credentials)
  2. Set WAREHOUSE_TYPE=snowflake or WAREHOUSE_TYPE=bigquery
  3. npm install
  4. npm run crawl            (one-time topology scan)
  5. npm run index            (one-time vectorization)
  6. node src/index.js query "How many orders were placed last month?"
      `);
  }
}

main().catch(err => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
