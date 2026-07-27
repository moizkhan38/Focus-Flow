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

// Managed Postgres (RDS, Supabase, Neon, Heroku, Azure) requires TLS.
//
// DATABASE_SSL=true previously meant TLS with certificate verification DISABLED,
// which encrypts the link but authenticates nothing — anyone who can intercept
// the connection can present their own certificate and read or rewrite every
// query, credentials included. Verification is now the default.
//
// Providers that present a self-signed chain need their CA supplied via
// DATABASE_CA (PEM). DATABASE_SSL_INSECURE=true restores the old unverified
// behaviour as a deliberate, named escape hatch — it logs a warning so it cannot
// be switched on and forgotten.
function buildSsl() {
  if (process.env.DATABASE_SSL !== 'true') return undefined;
  if (process.env.DATABASE_SSL_INSECURE === 'true') {
    console.warn(
      '[DB] DATABASE_SSL_INSECURE=true — TLS certificate verification is OFF. ' +
      'The connection is encrypted but NOT authenticated. Supply DATABASE_CA instead.'
    );
    return { rejectUnauthorized: false };
  }
  const ca = process.env.DATABASE_CA;
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}
const ssl = buildSsl();

// Which database is this, in one glance and without leaking the password.
//
// Local dev and the deployed app can point at the same Postgres or at different
// ones, and "which database am I looking at?" is not a question anyone should
// have to reverse-engineer from a connection string. Getting it wrong wastes
// real time: a credential saved in one is invisible in the other, and looks for
// all the world like the save silently failed.
export function describeDatabase() {
  try {
    const u = new URL(connectionString);
    const host = u.hostname;
    return {
      host,
      port: u.port || '5432',
      database: u.pathname.slice(1) || '(default)',
      isLocal: ['localhost', '127.0.0.1', '::1', 'postgres', 'db'].includes(host),
    };
  } catch {
    return { host: '(unparseable)', port: '?', database: '?', isLocal: false };
  }
}

export function databaseLabel() {
  const d = describeDatabase();
  return `${d.host}:${d.port}/${d.database}${d.isLocal ? ' (local)' : ' (REMOTE)'}`;
}

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
