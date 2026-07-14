import 'dotenv/config';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import rateLimit from 'express-rate-limit';
import { Server as SocketIOServer } from 'socket.io';
import { refreshAllDevelopers } from './services/developerRefresher.js';
import epicsRouter from './routes/epics.js';
import developersRouter from './routes/developers.js';
import assignmentRouter from './routes/assignment.js';
import jiraRouter from './routes/jira.js';
import syncRouter from './routes/sync.js';
import standupRouter from './routes/standup.js';
import dbRouter from './routes/db.js';
import { ping as pingDb, pool, query } from './db.js';
import { setIo } from './io.js';

const app = express();
const PORT = process.env.PORT || 3003;

// Behind a reverse proxy/load balancer, set TRUST_PROXY=1 so rate limiting and
// client IPs are correct. 0 (trust nothing) is the safe default for direct exposure.
app.set('trust proxy', Number(process.env.TRUST_PROXY || 0));

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

// Liveness check — registered BEFORE the rate limiter so health probes are never throttled.
app.get('/api/health', (req, res) => {
  res.json({
    status: 'running',
    service: 'Epic Dev Assignment Backend',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// Global rate limit across the API (the stricter AI limiter still applies in epics.js).
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_MAX || 300),
  standardHeaders: true,
  legacyHeaders: false,
}));

// Routes
app.use('/api', epicsRouter);
app.use('/api', developersRouter);
app.use('/api', assignmentRouter);
app.use('/api', jiraRouter);
app.use('/api', syncRouter);
app.use('/api', standupRouter);
app.use('/api', dbRouter);

// Global error handler (last middleware). Log the real error; return a safe message.
// Only errors explicitly marked expose:true reveal their message to the client.
app.use((err, req, res, _next) => {
  console.error('[API] Unhandled error:', err);
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

io.on('connection', (socket) => {
  // Clients join a project room by Jira project key to receive realtime updates
  socket.on('join', (projectKey) => {
    if (typeof projectKey === 'string' && /^[A-Z][A-Z0-9]{1,9}$/.test(projectKey.toUpperCase())) {
      socket.join(`project:${projectKey.toUpperCase()}`);
    }
  });
  socket.on('leave', (projectKey) => {
    if (typeof projectKey === 'string') socket.leave(`project:${projectKey.toUpperCase()}`);
  });
});

setIo(io);

// Process-level guards so a stray rejection/exception is logged, not silent.
process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught exception:', err);
  process.exit(1);
});

httpServer.listen(PORT, async () => {
  console.log(`✅ Backend listening on port ${PORT} (all interfaces)`);
  console.log(`📡 API at /api  ·  🔌 Socket.io on the same port`);
  const dbOk = await pingDb();
  console.log(dbOk ? '🗄️  PostgreSQL: connected' : '⚠️  PostgreSQL: unreachable (set DATABASE_URL in .env)');

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
          console.log('[DevRefresh] another instance holds the lock — skipping this run');
          return;
        }
        await refreshAllDevelopers();
      } catch (err) {
        console.error('[DevRefresh] cron failed:', err.message);
      } finally {
        if (locked) await query('SELECT pg_advisory_unlock(823471)').catch(() => {});
      }
    });
    console.log(`⏰ Developer refresh scheduled: "${schedule}"`);
  }
});

// Graceful shutdown — stop accepting connections, close sockets + DB pool, then exit.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Shutdown] ${signal} received — closing server...`);
  const forceExit = setTimeout(() => {
    console.error('[Shutdown] forced exit after 10s');
    process.exit(1);
  }, 10000);
  forceExit.unref();
  io.close();
  httpServer.close(async () => {
    try { await pool.end(); } catch { /* ignore */ }
    console.log('[Shutdown] clean');
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
