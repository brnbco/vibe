import snowflake from 'snowflake-sdk';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { getConfig } from './config.js';

snowflake.configure({ logLevel: 'OFF' });

function buildConnectionOptions(cfg) {
  const opts = {
    account:   cfg.account,
    username:  cfg.username,
    warehouse: cfg.warehouse,
    role:      cfg.role,
  };

  if (cfg.privateKeyPath) {
    const keyPath = resolve(cfg.privateKeyPath);
    const privateKey = readFileSync(keyPath, 'utf-8');
    opts.authenticator = 'SNOWFLAKE_JWT';
    opts.privateKey = privateKey;
  } else if (cfg.password) {
    opts.password = cfg.password;
  } else {
    throw new Error(
      'Snowflake auth: set SNOWFLAKE_PRIVATE_KEY_PATH (recommended) or SNOWFLAKE_PASSWORD in .env'
    );
  }

  return opts;
}

export function createConnection(overrides = {}) {
  const cfg = getConfig().warehouse;
  const opts = { ...buildConnectionOptions(cfg), ...overrides };

  return new Promise((resolve, reject) => {
    const conn = snowflake.createConnection(opts);
    conn.connect((err, c) => {
      if (err) reject(new Error(`Snowflake connect failed: ${err.message}`));
      else resolve(c);
    });
  });
}

export function execute(conn, sqlText, binds = []) {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      binds,
      complete(err, _stmt, rows) {
        if (err) reject(new Error(`SQL error: ${err.message}\n  Query: ${sqlText}`));
        else resolve(rows || []);
      },
    });
  });
}

export function destroy(conn) {
  return new Promise((resolve) => {
    conn.destroy(() => resolve());
  });
}
