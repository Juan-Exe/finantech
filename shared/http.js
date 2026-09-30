'use strict';
// Mini framework HTTP sin dependencias: enrutamiento, lectura de JSON y manejo uniforme de errores.
const http = require('node:http');

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

class Reply {
  constructor(status, body) {
    this.status = status;
    this.body = body;
  }
}

const reply = (status, body) => new Reply(status, body);

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'El cuerpo de la solicitud es demasiado grande'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function assert(condition, status, message, details) {
  if (!condition) throw new HttpError(status, message, details);
}

function required(body, fields) {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === '');
  assert(missing.length === 0, 400, `Campos obligatorios faltantes: ${missing.join(', ')}`);
}

function createApp(name) {
  const routes = [];
  const add = (method) => (pattern, handler) => {
    const keys = [];
    const source = pattern.replace(/:([A-Za-z_]+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });
    routes.push({ method, re: new RegExp(`^${source}/?$`), keys, handler });
  };

  const app = {
    name,
    get: add('GET'),
    post: add('POST'),
    put: add('PUT'),
    patch: add('PATCH'),
    delete: add('DELETE'),
  };

  app.get('/health', () => ({ service: name, status: 'UP', uptimeSeconds: Math.round(process.uptime()) }));

  app.handle = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      let route;
      let match;
      for (const r of routes) {
        if (r.method !== req.method) continue;
        match = r.re.exec(url.pathname);
        if (match) {
          route = r;
          break;
        }
      }
      if (!route) throw new HttpError(404, 'Recurso no encontrado');

      req.params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
      req.query = Object.fromEntries(url.searchParams);
      req.body = {};
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        const raw = await readBody(req);
        if (raw.length) {
          try {
            req.body = JSON.parse(raw.toString('utf8'));
          } catch {
            throw new HttpError(400, 'El cuerpo no es un JSON válido');
          }
        }
      }

      const result = await route.handler(req, res);
      if (res.headersSent) return;
      if (result instanceof Reply) send(res, result.status, result.body);
      else send(res, 200, result);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(`[${name}]`, err);
      if (!res.headersSent) {
        send(res, status, { error: err.message || 'Error interno', ...(err.details ? { details: err.details } : {}) });
      }
    }
  };

  app.listen = (port, host = '127.0.0.1') =>
    new Promise((resolve) => {
      const server = http.createServer(app.handle);
      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[${name}] El puerto ${port} ya está en uso. ¿Hay otra copia de FinanTech abierta? Ciérrela o use PORT_OFFSET.`);
          process.exit(1);
        }
        throw err;
      });
      server.listen(port, host, () => {
        console.log(`[${name}] escuchando en http://${host}:${port}`);
        resolve(server);
      });
    });

  return app;
}

module.exports = { createApp, HttpError, reply, send, readBody, assert, required };
