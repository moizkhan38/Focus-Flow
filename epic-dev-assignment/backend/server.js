import 'dotenv/config';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import rateLimit from 'express-rate-limit';
import { clerkMiddleware } from '@clerk/express';
import { verifyToken } from '@clerk/backend';
import { Server as SocketIOServer } from 'socket.io';
import { requireOrg, orgOrInternal } from './middleware/auth.js';
import { refreshAllDevelopers } from './services/developerRefresher.js';
import epicsRouter from './routes/epics.js';
import developersRouter from './routes/developers.js';
import assignmentRouter from './routes/assignment.js';
import jiraRouter from './routes/jira.js';
import syncRouter from './routes/sync.js';
import standupRouter from './routes/standup.js';
import dbRouter from './routes/db.js';
import integrationsRouter from './routes/integrations.js';
import { ping as pingDb, pool, query } from './db.js';
import { setIo } from './io.js';
import { assertMasterKey } from './services/cryptoService.js';
import { logger, httpLogger } from './logger.js';

const app = express();
const PORT = process.env.PORT || 3003;

// Clerk is mandatory: without it the API would be open to the internet.
if (!process.env.CLERK_SECRET_KEY) {
  logger.error(
    '[Auth] FATAL: CLERK_SECRET_KEY is not set — refusing to start an unauthenticated API. ' +
    'Add it to backend/.env (see .env.example).'
  );
  process.exit(1);
}

// The integrations API stores per-org Jira/GitHub credentials encrypted with the
// master key. Fail fast at boot if it's missing/malformed rather than at the
// first credential save.
assertMasterKey();

// Behind a reverse proxy/load balancer, set TRUST_PROXY=1 so rate limiting and
// client IPs are correct. 0 (trust nothing) is the safe default for direct exposure.
app.set('trust proxy', Number(process.env.TRUST_PROXY || 0));

// Structured request logging first: assigns/propagates X-Request-Id and attaches
// a per-request child logger at req.log so a request's lines all share one id.
app.use(httpLogger);

// CORS restricted to known origins (no wildcard). A disallowed browser origin gets
// no CORS headers via cb(null, false) rather than a thrown error (which would 500).
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3003')
  .split(',').map(o => o.trim());
app.use(cors({
  origin: (origin, cb) => {
    // Allow tools like curl/Postman (no origin) and whitelisted origins.
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
}));

app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '2mb' }));

// Parses Clerk session JWTs (Authorization: Bearer) into req auth state.
// Enforcement happens per-router via requireOrg below.
app.use(clerkMiddleware({
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
  secretKey: process.env.CLERK_SECRET_KEY,
}));

// Liveness — no dependencies, always 200 while the process is up. Used to decide
// whether to RESTART the container. Registered before the rate limiter + auth gate
// so probes are never throttled or blocked.
app.get('/api/health', (req, res) => {
  res.json({
    status: 'running',
    service: 'Epic Dev Assignment Backend',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// Readiness — checks dependencies (Postgres). Used by load balancers/orchestrators
// to decide whether to ROUTE TRAFFIC here: 200 when the DB is reachable, 503 when
// not (so a booting/DB-less instance is pulled from rotation without being killed).
app.get('/api/ready', async (req, res) => {
  const dbOk = await pingDb();
  res.status(dbOk ? 200 : 503).json({ status: dbOk ? 'ready' : 'not ready', db: dbOk });
});

// Global rate limit across the API (the stricter AI limiter still applies in epics.js).
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_MAX || 300),
  standardHeaders: true,
  legacyHeaders: false,
}));

// ── Default-closed auth gate ─────────────────────────────────────────────────
// ONE gate for the whole flat /api namespace. Everything requires a signed-in
// user with an active org EXCEPT the explicit allowlist below. Default-closed:
// a newly added route is protected automatically. (Attaching guards per-router
// doesn't work here: with all routers mounted at '/api', every request enters
// every router, so any router-level guard would intercept other routers' routes
// — including the bot's internal lane.)
// Consequence: unmatched /api/* paths return 401 unauthenticated (not 404).
app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path === '/db/health') return next(); // open probes
  if (req.path === '/db/standups') return orgOrInternal(req, res, next);  // bot's internal lane
  return requireOrg(req, res, next);
});

// Routes — auth enforced by the gate above.
app.use('/api', epicsRouter);
app.use('/api', developersRouter);
app.use('/api', assignmentRouter);
app.use('/api', jiraRouter);
app.use('/api', syncRouter);
app.use('/api', standupRouter);
app.use('/api', dbRouter);
app.use('/api', integrationsRouter);

// Global error handler (last middleware). Log the real error; return a safe message.
// Only errors explicitly marked expose:true reveal their message to the client.
app.use((err, req, res, _next) => {
  if (err?.name === 'IntegrationNotConnectedError') {
    // Org hasn't connected this provider — actionable 412, not a server fault.
    if (!res.headersSent) res.status(412).json({ success: false, error: err.code });
    return;
  }
  (req.log || logger).error({ err }, 'unhandled error');
  if (res.headersSent) return;
  res.status(err.status || 500).json({
    success: false,
    error: err.expose ? err.message : 'Internal server error',
  });
});

// Create HTTP server so Socket.io can piggyback on the same port
const httpServer = http.createServer(app);

const io = new SocketIOServer(httpServer, {
  cors: { origin: allowedOrigins, credentials: true },
});

// Socket handshake auth: every connection must present a valid Clerk session
// token with an active org. The client sends it via auth() (see useRealtime.js).
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('unauthorized'));
    const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
    // v2 session tokens carry org under `o.id`; v1 used `org_id`.
    const orgId = payload.o?.id || payload.org_id || null;
    if (!orgId) return next(new Error('no active organization'));
    socket.userId = payload.sub;
    socket.orgId = orgId;
    return next();
  } catch {
    return next(new Error('unauthorized'));
  }
});

io.on('connection', (socket) => {
  // Clients join a project room by Jira project key. The key must belong to a
  // project in the caller's org — otherwise any org's member could listen to
  // another org's realtime issue events.
  socket.on('join', async (projectKey) => {
    if (typeof projectKey !== 'string' || !/^[A-Z][A-Z0-9]{1,9}$/.test(projectKey.toUpperCase())) return;
    const key = projectKey.toUpperCase();
    try {
      const { rows } = await query(
        'SELECT 1 FROM projects WHERE jira_project_key = $1 AND org_id = $2 LIMIT 1',
        [key, socket.orgId]
      );
      if (rows.length > 0) socket.join(`project:${key}`);
    } catch {
      // deny on error — no room join
    }
  });
  socket.on('leave', (projectKey) => {
    if (typeof projectKey === 'string') socket.leave(`project:${projectKey.toUpperCase()}`);
  });
});

setIo(io);

// Process-level guards so a stray rejection/exception is logged, not silent.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaught exception');
  process.exit(1);
});

httpServer.listen(PORT, async () => {
  logger.info({ port: PORT }, 'backend listening (API at /api, Socket.io on same port)');
  const dbOk = await pingDb();
  if (dbOk) logger.info('postgres connected');
  else logger.warn('postgres unreachable (set DATABASE_URL in .env)');

  // Daily developer roster refresh. Guarded by a Postgres advisory lock so running
  // multiple instances doesn't fire N concurrent GitHub-hammering runs at 03:00.
  if (dbOk) {
    const schedule = process.env.DEV_REFRESH_CRON || '0 3 * * *';
    cron.schedule(schedule, async () => {
      let locked = false;
      try {
        const { rows } = await query('SELECT pg_try_advisory_lock(823471) AS ok');
        locked = rows[0]?.ok === true;
        if (!locked) {
          logger.info('[DevRefresh] another instance holds the lock — skipping this run');
          return;
        }
        await refreshAllDevelopers();
      } catch (err) {
        logger.error({ err }, '[DevRefresh] cron failed');
      } finally {
        if (locked) await query('SELECT pg_advisory_unlock(823471)').catch(() => {});
      }
    });
    logger.info({ schedule }, 'developer refresh scheduled');
  }
});

// Graceful shutdown — stop accepting connections, close sockets + DB pool, then exit.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutdown: closing server');
  const forceExit = setTimeout(() => {
    logger.error('shutdown: forced exit after 10s');
    process.exit(1);
  }, 10000);
  forceExit.unref();
  io.close();
  httpServer.close(async () => {
    try { await pool.end(); } catch { /* ignore */ }
    logger.info('shutdown: clean');
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
