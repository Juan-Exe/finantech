'use strict';
// Capa 2 — API Gateway: punto único de entrada.
// Valida tokens, aplica control de acceso por rol, límites de uso, enruta hacia el microservicio,
// deja una bitácora de auditoría encadenada por hash y sirve los canales web/móvil.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { verify } = require('../shared/jwt');
const { JWT_SECRET, ports, urls, STAFF_ROLES } = require('../shared/config');
const { send, readBody, HttpError } = require('../shared/http');
const { createStore } = require('../shared/store');

const WEB_ROOT = path.join(__dirname, '..', 'web');

const ROUTES = [
  { prefix: '/api/auth', target: 'identity', rewrite: '/auth' },
  { prefix: '/api/users', target: 'identity', rewrite: '/users', roles: ['admin'] },
  { prefix: '/api/customers', target: 'customers', rewrite: '/customers' },
  { prefix: '/api/products', target: 'credits', rewrite: '/products' },
  { prefix: '/api/credits', target: 'credits', rewrite: '/credits' },
  { prefix: '/api/evaluations', target: 'evaluation', rewrite: '/evaluations', roles: STAFF_ROLES },
  { prefix: '/api/payments', target: 'disbursement', rewrite: '/payments' },
  { prefix: '/api/disbursements', target: 'disbursement', rewrite: '/disbursements', roles: STAFF_ROLES },
  { prefix: '/api/accounting', target: 'accounting', rewrite: '', roles: STAFF_ROLES },
  { prefix: '/api/notifications', target: 'notifications', rewrite: '/notifications' },
  { prefix: '/api/analytics', target: 'analytics', rewrite: '', roles: STAFF_ROLES },
  { prefix: '/api/bus', target: 'bus', rewrite: '', roles: ['admin'] },
];

const PUBLIC = new Set([
  'POST /api/auth/register',
  'POST /api/auth/login',
  'POST /api/auth/mfa',
  'GET /api/products',
  'GET /api/credits/simulate',
  'GET /api/health',
]);

const SERVICES = ['identity', 'customers', 'credits', 'evaluation', 'disbursement', 'accounting', 'notifications', 'analytics', 'bus'];

// ---------- Auditoría inmutable (cadena de hashes) ----------
const audit = createStore('gateway-audit', { entries: [] });
const MAX_AUDIT = 3000;

function appendAudit(entry) {
  const entries = audit.data.entries;
  const prevHash = entries.length ? entries[entries.length - 1].hash : 'GENESIS';
  const record = { seq: (entries.at(-1)?.seq || 0) + 1, ...entry, prevHash };
  record.hash = crypto.createHash('sha256').update(prevHash + JSON.stringify({ ...record, hash: undefined })).digest('hex');
  entries.push(record);
  if (entries.length > MAX_AUDIT) entries.splice(0, entries.length - MAX_AUDIT);
  audit.save();
}

function verifyAuditChain() {
  const entries = audit.data.entries;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (i > 0 && e.prevHash !== entries[i - 1].hash) return { valid: false, brokenAt: e.seq };
    const expected = crypto.createHash('sha256').update(e.prevHash + JSON.stringify({ ...e, hash: undefined })).digest('hex');
    if (expected !== e.hash) return { valid: false, brokenAt: e.seq };
  }
  return { valid: true };
}

// ---------- Límites de uso ----------
const buckets = new Map();
function rateLimit(key, limit) {
  const windowMs = 60_000;
  const t = Date.now();
  const b = buckets.get(key);
  if (!b || t - b.start > windowMs) {
    buckets.set(key, { start: t, count: 1 });
    return;
  }
  b.count += 1;
  if (b.count > limit) throw new HttpError(429, 'Demasiadas solicitudes. Intente de nuevo en un minuto.');
}

// ---------- Estáticos (canales) ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function serveStatic(pathname, res) {
  let file = path.normalize(path.join(WEB_ROOT, decodeURIComponent(pathname)));
  if (!file.startsWith(WEB_ROOT)) return send(res, 403, { error: 'Prohibido' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB_ROOT, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

async function health() {
  const results = await Promise.all(
    SERVICES.map(async (name) => {
      const started = Date.now();
      try {
        const r = await fetch(`${urls[name]}/health`, { signal: AbortSignal.timeout(1500) });
        return { service: name, status: r.ok ? 'UP' : 'DOWN', latencyMs: Date.now() - started };
      } catch {
        return { service: name, status: 'DOWN', latencyMs: null };
      }
    }),
  );
  return { gateway: 'UP', services: results, checkedAt: new Date().toISOString() };
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  if (!pathname.startsWith('/api/')) return serveStatic(pathname, res);

  const started = Date.now();
  const requestId = crypto.randomUUID();
  const ip = req.socket.remoteAddress;
  const channel = req.headers['x-channel'] || 'api';
  let claims = null;
  let status = 500;

  try {
    const key = `${req.method} ${pathname}`;
    rateLimit(`ip:${ip}`, 600);
    if (pathname.startsWith('/api/auth/login') || pathname.startsWith('/api/auth/mfa')) rateLimit(`auth:${ip}`, 30);

    if (key === 'GET /api/health') {
      status = 200;
      return send(res, 200, await health());
    }

    const route = ROUTES.find((r) => pathname === r.prefix || pathname.startsWith(`${r.prefix}/`));
    const isPublic = PUBLIC.has(key);

    if (!isPublic) {
      const header = req.headers.authorization || '';
      claims = verify(header.startsWith('Bearer ') ? header.slice(7) : '', JWT_SECRET);
      if (!claims || claims.typ !== 'access') throw new HttpError(401, 'Autenticación requerida');
    }

    if (key === 'GET /api/audit') {
      if (claims.role !== 'admin') throw new HttpError(403, 'Solo administradores');
      const limit = Math.min(Number(url.searchParams.get('limit')) || 150, 500);
      status = 200;
      return send(res, 200, {
        integrity: verifyAuditChain(),
        total: audit.data.entries.length,
        entries: audit.data.entries.slice(-limit).reverse(),
      });
    }

    if (!route) throw new HttpError(404, 'Ruta no encontrada en el API Gateway');
    if (route.roles && !route.roles.includes(claims?.role)) throw new HttpError(403, 'No tiene permisos para esta operación');

    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
    const upstreamPath = route.rewrite + pathname.slice(route.prefix.length) + url.search;
    let upstream;
    try {
      upstream = await fetch(urls[route.target] + upstreamPath, {
        method: req.method,
        headers: {
          'Content-Type': 'application/json',
          ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
          'X-Request-Id': requestId,
          'X-Channel': channel,
          'X-Forwarded-For': ip,
        },
        body: body && body.length ? body : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new HttpError(503, `El servicio ${route.target} no está disponible`);
    }
    status = upstream.status;
    const text = await upstream.text();
    res.writeHead(status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'X-Request-Id': requestId,
    });
    res.end(text);
  } catch (err) {
    status = err.status || 500;
    if (status >= 500 && status !== 503) console.error('[gateway]', err);
    send(res, status, { error: err.message }, { 'X-Request-Id': requestId });
  } finally {
    if (pathname !== '/api/health') {
      appendAudit({
        at: new Date().toISOString(),
        requestId,
        method: req.method,
        path: pathname,
        status,
        user: claims?.email || claims?.sub || 'anónimo',
        role: claims?.role || '-',
        channel,
        ip,
        ms: Date.now() - started,
      });
    }
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[gateway] El puerto ${ports.gateway} ya está en uso. Ciérrelo o elija otro, p. ej. PORT=3000.`);
    process.exit(1);
  }
  throw err;
});

server.listen(ports.gateway, process.env.HOST || '127.0.0.1', () => {
  console.log(`[gateway] escuchando en http://localhost:${ports.gateway}`);
});
