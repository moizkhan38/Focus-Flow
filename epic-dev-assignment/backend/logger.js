import pino from 'pino';
import pinoHttp from 'pino-http';
import { randomUUID } from 'node:crypto';

// Structured logging (Phase 3, step 3.2). JSON lines to stdout; LOG_LEVEL env
// (default 'info'). Redaction below is the safety net that keeps credentials out
// of logs even if something tries to log a request/headers/body wholesale.
const redact = {
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-internal-key"]',
    'req.headers["x-admin-key"]',
    'apiToken',
    'token',
    'apiKey',
    'password',
    '*.apiToken',
    '*.token',
    '*.apiKey',
    '*.password',
  ],
  censor: '[redacted]',
};

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'backend' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact,
});

// pino-http gives every request a child logger on req.log carrying its reqId, so
// a whole request's log lines correlate. Inbound X-Request-Id is honored (trace
// across services / through a proxy); otherwise a UUID is minted. The id is
// echoed back on the response so clients/proxies can correlate too.
export const httpLogger = pinoHttp({
  logger,
  genReqId(req, res) {
    const incoming = req.headers['x-request-id'];
    const id = (typeof incoming === 'string' && incoming.trim()) || randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },
  customLogLevel(req, res, err) {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  // Health/readiness probes fire constantly — don't drown the logs in them.
  autoLogging: {
    ignore: (req) => req.url === '/api/health' || req.url === '/api/ready',
  },
});
