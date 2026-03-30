import { crawlTopology } from './crawl.js';
import { indexTopology } from './embed.js';
import { searchOntology } from './search.js';
import { compileSQL } from './compile.js';
import { executeSQL, formatResults } from './execute.js';

const [,, command, ...rest] = process.argv;
const question = rest.join(' ');

async function runCrawl() {
  console.log('\n⛏  Crawling Snowflake topology…');
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

  console.log('\n┌─── Ontology Context (sent to compiler) ───');
  for (const m of matches) {
    console.log(`│`);
    m.ddl.split('\n').forEach(l => console.log(`│ ${l}`));
  }
  console.log(`└────────────────────────────────────────────`);

  console.log('\n🔧 Compiling SQL…');
  const sql = await compileSQL(q, matches);
  console.log(`\n┌─── Generated SQL ───`);
  console.log(sql.split('\n').map(l => `│ ${l}`).join('\n'));
  console.log(`└─────────────────────`);

  console.log('\n⚡ Executing…');
  const results = await executeSQL(sql);
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
semantic-compiler — natural language → Snowflake SQL

Commands:
  crawl                          Discover warehouse topology and save locally
  index                          Embed topology into Pinecone vector DB
  query  "your question here"    Search ontology → compile SQL → execute
  pipeline "your question"       Full run: crawl → index → query

Setup:
  1. cp env.sample .env  (fill in credentials)
  2. npm install
  3. npm run crawl       (one-time topology scan)
  4. npm run index       (one-time vectorization)
  5. node src/index.js query "How many orders were placed last month?"
      `);
  }
}

main().catch(err => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
