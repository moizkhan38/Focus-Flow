import pg from 'pg';
import { logger } from './logger.js';

const { Pool } = pg;

// No hardcoded fallback: silently connecting to a wrong/local DB is worse than
// failing loudly, and a real credential must never live in source (or git history).
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  logger.error(
    '[DB] FATAL: DATABASE_URL is not set — refusing to start. ' +
    'Configure it in backend/.env (see .env.example).'
  );
  process.exit(1);
}

// Managed Postgres (RDS, Supabase, Neon, Heroku, Azure) requires TLS and
// usually presents a self-signed chain. Enable with DATABASE_SSL=true.
const ssl = process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined;

export const pool = new Pool({
  connectionString,
  ssl,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error({ err }, '[DB] unexpected pool error');
});

export async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const ms = Date.now() - start;
    if (ms > 200) logger.warn({ ms, sql: text.slice(0, 80) }, '[DB] slow query');
    return res;
  } catch (err) {
    logger.error({ err, sql: text.slice(0, 120) }, '[DB] query failed');
    throw err;
  }
}

export async function ping() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
