'use strict';
// Levanta la plataforma completa: bus de eventos, 8 microservicios y API Gateway, cada uno en su propio proceso.
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const COMPONENTS = [
  { name: 'bus', entry: 'event-bus/index.js', color: 35 },
  { name: 'identity', entry: 'services/identity/index.js', color: 36 },
  { name: 'customers', entry: 'services/customers/index.js', color: 32 },
  { name: 'credits', entry: 'services/credits/index.js', color: 33 },
  { name: 'evaluation', entry: 'services/evaluation/index.js', color: 34 },
  { name: 'disbursement', entry: 'services/disbursement/index.js', color: 91 },
  { name: 'accounting', entry: 'services/accounting/index.js', color: 92 },
  { name: 'notifications', entry: 'services/notifications/index.js', color: 93 },
  { name: 'analytics', entry: 'services/analytics/index.js', color: 94 },
  { name: 'gateway', entry: 'gateway/index.js', color: 97 },
];

function startAll({ env = {}, silent = false } = {}) {
  const children = COMPONENTS.map(({ name, entry, color }) => {
    const child = spawn(process.execPath, [path.join(ROOT, entry)], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const prefix = `\x1b[${color}m${name.padEnd(13)}\x1b[0m│ `;
    const pipe = (stream, out) => {
      let buffer = '';
      stream.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        if (!silent) for (const line of lines) out.write(prefix + line + '\n');
      });
    };
    pipe(child.stdout, process.stdout);
    pipe(child.stderr, process.stderr);
    child.on('exit', (code) => {
      if (!child.stopping && !silent) console.log(`${prefix}terminó con código ${code}`);
    });
    return child;
  });
  const stop = () => {
    for (const c of children) {
      c.stopping = true;
      c.kill();
    }
  };
  return { children, stop };
}

if (require.main === module) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    console.error(`FinanTech requiere Node.js 20 o superior (versión actual: ${process.version}). Descárguelo en https://nodejs.org`);
    process.exit(1);
  }
  const { ports } = require('../shared/config');
  const { children, stop } = startAll();
  // Si un componente cae durante el arranque (p. ej. puerto ocupado), se detiene todo con un mensaje claro.
  let booting = true;
  setTimeout(() => (booting = false), 5000);
  for (const child of children) {
    child.on('exit', (code) => {
      if (booting && code) {
        booting = false;
        console.error('\nNo se pudo iniciar la plataforma. Revise el mensaje anterior.');
        stop();
        setTimeout(() => process.exit(1), 300);
      }
    });
  }
  setTimeout(() => {
    console.log(`
\x1b[1m  FinanTech — prototipo funcional\x1b[0m
  ─────────────────────────────────────────────
  Abrir:        \x1b[36mhttp://localhost:${ports.gateway}\x1b[0m
  Administrador: admin@finantech.co    / Admin2026!
  Analista:      analista@finantech.co / Analista2026!
  Cliente:       cree una cuenta desde "Crear cuenta"
  Ctrl+C para detener todos los servicios.
`);
  }, 1200);
  const shutdown = () => {
    stop();
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { startAll, COMPONENTS };
