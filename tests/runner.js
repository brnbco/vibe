import { readFileSync, writeFileSync, watch } from 'fs';
import { searchOntology } from '../src/search.js';
import { compileSQL, recompileSQL, buildCompilerContext } from '../src/compile.js';
import { executeSQL, formatResults } from '../src/execute.js';

const MAX_RETRIES = 2;

const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
  bgRed:   '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow:'\x1b[43m',
  bgBlue:  '\x1b[44m',
};

async function runSingleQuery(test) {
  const t0 = Date.now();
  const result = {
    id: test.id,
    query: test.query,
    tables: [],
    sql: null,
    retries: 0,
    rowCount: 0,
    firstRow: null,
    error: null,
    durationMs: 0,
  };

  try {
    const matches = await searchOntology(test.query);
    result.tables = matches.map(m => `${m.id} (${m.score.toFixed(3)})`);

    if (matches.length === 0) {
      result.error = 'No relevant tables found';
      result.durationMs = Date.now() - t0;
      return result;
    }

    let sql = null;
    let execResult = null;
    let lastError = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt === 0) {
        sql = await compileSQL(test.query, matches);
      } else {
        result.retries++;
        sql = await recompileSQL(test.query, matches, sql, lastError);
      }
      result.sql = sql;

      try {
        execResult = await executeSQL(sql);
        break;
      } catch (err) {
        lastError = err.message;
        if (attempt === MAX_RETRIES) {
          result.error = `Execution failed after ${MAX_RETRIES + 1} attempts: ${lastError}`;
        }
      }
    }

    if (execResult) {
      result.rowCount = execResult.rowCount;
      if (execResult.rows.length > 0) {
        result.firstRow = {};
        for (const [k, v] of Object.entries(execResult.rows[0])) {
          if (v && typeof v === 'object' && v.value !== undefined) {
            result.firstRow[k] = v.value;
          } else {
            result.firstRow[k] = v;
          }
        }
      }
      result.formatted = formatResults(execResult);
    }
  } catch (err) {
    result.error = err.message;
  }

  result.durationMs = Date.now() - t0;
  return result;
}

function statusBadge(r) {
  if (r.error) return `${c.bgRed}${c.white}${c.bold} FAIL ${c.reset}`;
  if (r.rowCount > 0 && r.firstRow) {
    const hasNulls = Object.values(r.firstRow).some(v => v === null);
    if (hasNulls) return `${c.bgYellow}${c.bold} WARN ${c.reset}`;
    return `${c.bgGreen}${c.bold} PASS ${c.reset}`;
  }
  return `${c.bgYellow}${c.bold} EMPTY ${c.reset}`;
}

function printResult(r, idx) {
  const badge = statusBadge(r);
  const timing = `${c.dim}${(r.durationMs / 1000).toFixed(1)}s${r.retries > 0 ? `, ${r.retries} retries` : ''}${c.reset}`;

  console.log(`\n${c.blue}${'═'.repeat(80)}${c.reset}`);
  console.log(`  ${badge}  ${c.bold}${c.white}${idx + 1}. ${r.id}${c.reset}  ${timing}`);
  console.log(`${c.blue}${'═'.repeat(80)}${c.reset}`);

  console.log(`  ${c.cyan}Query:${c.reset} ${r.query}`);

  console.log(`  ${c.cyan}Tables:${c.reset}`);
  r.tables.slice(0, 3).forEach(t => console.log(`    ${c.dim}→${c.reset} ${t}`));

  if (r.sql) {
    console.log(`  ${c.cyan}SQL:${c.reset}`);
    r.sql.split('\n').forEach(l => console.log(`    ${c.magenta}${l}${c.reset}`));
  }

  if (r.error) {
    console.log(`  ${c.red}${c.bold}Error:${c.reset} ${c.red}${r.error}${c.reset}`);
  } else if (r.formatted) {
    console.log(`  ${c.cyan}Results:${c.reset} ${c.dim}(${r.rowCount} rows)${c.reset}`);
    r.formatted.split('\n').slice(0, 12).forEach(l => console.log(`    ${c.green}${l}${c.reset}`));
  }
}

function printSummary(results) {
  const pass  = results.filter(r => !r.error && r.rowCount > 0 && r.firstRow && !Object.values(r.firstRow).some(v => v === null));
  const warn  = results.filter(r => !r.error && r.rowCount > 0 && r.firstRow && Object.values(r.firstRow).some(v => v === null));
  const empty = results.filter(r => !r.error && (r.rowCount === 0 || !r.firstRow));
  const fail  = results.filter(r => r.error);
  const totalMs = results.reduce((s, r) => s + r.durationMs, 0);
  const retries = results.reduce((s, r) => s + r.retries, 0);

  console.log(`\n${c.yellow}${'━'.repeat(80)}${c.reset}`);
  console.log(`  ${c.bold}${c.white}TEST SUMMARY${c.reset}  ${c.dim}${new Date().toLocaleString()}${c.reset}`);
  console.log(`${c.yellow}${'━'.repeat(80)}${c.reset}`);

  console.log(`  ${c.bold}Total:${c.reset}    ${results.length}`);
  console.log(`  ${c.green}${c.bold}Pass:${c.reset}     ${pass.length}`);
  if (warn.length)  console.log(`  ${c.yellow}${c.bold}Warn:${c.reset}     ${warn.length}    ${c.dim}(data returned but has null columns)${c.reset}`);
  if (empty.length) console.log(`  ${c.yellow}${c.bold}Empty:${c.reset}    ${empty.length}    ${c.dim}(executed but no data)${c.reset}`);
  if (fail.length)  console.log(`  ${c.red}${c.bold}Fail:${c.reset}     ${fail.length}`);
  console.log(`  ${c.dim}Retries:  ${retries}    Duration: ${(totalMs / 1000).toFixed(1)}s${c.reset}`);

  console.log(`\n${c.yellow}${'─'.repeat(80)}${c.reset}`);

  for (const r of results) {
    const badge = statusBadge(r);
    const nullCols = r.firstRow
      ? Object.entries(r.firstRow).filter(([, v]) => v === null).map(([k]) => k)
      : [];
    const nullNote = nullCols.length ? `  ${c.yellow}[null: ${nullCols.join(', ')}]${c.reset}` : '';
    const retryNote = r.retries > 0 ? `  ${c.dim}${r.retries} retries${c.reset}` : '';
    const rows = r.error ? `${c.red}error${c.reset}` : `${r.rowCount} rows`;

    console.log(`  ${badge}  ${c.bold}${r.id.padEnd(25)}${c.reset} ${rows.padEnd(18)}  ${c.dim}${(r.durationMs / 1000).toFixed(1)}s${c.reset}${retryNote}${nullNote}`);
  }

  console.log(`${c.yellow}${'─'.repeat(80)}${c.reset}\n`);
}

async function runAll() {
  const queries = JSON.parse(readFileSync('tests/queries.json', 'utf-8'));
  console.log(`\n${c.bold}${c.blue}▶ Running ${queries.length} test queries in parallel…${c.reset}\n`);

  const results = await Promise.all(queries.map(q => runSingleQuery(q)));

  results.forEach((r, i) => printResult(r, i));
  printSummary(results);

  writeFileSync('tests/last-run.json', JSON.stringify(results, null, 2));
}

const isWatch = process.argv.includes('--watch');

await runAll();

if (isWatch) {
  console.log(`${c.cyan}${c.bold}👁 Watching src/ + tests/ for changes…${c.reset}\n`);
  let debounce = null;
  const rerun = (dir, filename) => {
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      console.log(`\n${c.yellow}↻ ${dir}/${filename} changed — re-running tests…${c.reset}`);
      try {
        await runAll();
      } catch (err) {
        console.error(`  ${c.red}✗ Runner error: ${err.message}${c.reset}`);
      }
    }, 1000);
  };
  watch('src', { recursive: true }, (event, f) => {
    if (f?.endsWith('.js')) rerun('src', f);
  });
  watch('tests', { recursive: true }, (event, f) => {
    if (f === 'last-run.json') return;
    if (f?.endsWith('.json') || f?.endsWith('.js')) rerun('tests', f);
  });
}
