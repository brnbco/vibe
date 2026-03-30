import { BigQuery } from '@google-cloud/bigquery';
import { getConfig } from './config.js';

let _client;

export function getClient() {
  if (_client) return _client;
  const cfg = getConfig().warehouse;
  _client = new BigQuery({
    projectId:   cfg.projectId,
    keyFilename: cfg.keyFile,
  });
  return _client;
}

export async function runQuery(sql) {
  const bq = getClient();
  const [rows] = await bq.query({ query: sql, useLegacySql: false });
  return rows;
}
