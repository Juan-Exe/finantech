'use strict';
// Carga datos de demostración pasando por el API Gateway, igual que lo haría un usuario real:
// cada cliente se registra, se vincula, solicita, firma y paga, y los eventos fluyen por el bus.
const crypto = require('node:crypto');

const PASSWORD = 'Cliente2026!';

const CLIENTS = [
  {
    email: 'maria.gomez@correo.co', firstName: 'María', lastName: 'Gómez', doc: '1067894523', city: 'Montería', channel: 'app-movil',
    credit: { product: 'libre_inversion', amount: 8_000_000, termMonths: 36, monthlyIncome: 6_500_000, monthlyExpenses: 1_500_000 },
    sign: true, payments: 3,
  },
  {
    email: 'ana.torres@correo.co', firstName: 'Ana', lastName: 'Torres', doc: '1045678912', city: 'Cereté', channel: 'portal-web',
    credit: { product: 'libre_inversion', amount: 12_000_000, termMonths: 48, monthlyIncome: 9_000_000, monthlyExpenses: 2_000_000 },
    sign: true, stepUp: true, payments: 1,
  },
  {
    email: 'jorge.herrera@correo.co', firstName: 'Jorge', lastName: 'Herrera', doc: '1003321457', city: 'Sahagún', channel: 'app-movil',
    credit: { product: 'educativo', amount: 4_500_000, termMonths: 24, monthlyIncome: 3_800_000, monthlyExpenses: 900_000 },
    sign: true, payments: 5,
  },
  {
    email: 'carlos.ruiz@correo.co', firstName: 'Carlos', lastName: 'Ruiz', doc: '1003456781', city: 'Montería', channel: 'portal-web',
    credit: { product: 'vehiculo', amount: 35_000_000, termMonths: 60, monthlyIncome: 14_000_000, monthlyExpenses: 3_000_000 },
  },
  {
    email: 'luisa.martinez@correo.co', firstName: 'Luisa', lastName: 'Martínez', doc: '1098765435', city: 'Lorica', channel: 'app-movil',
    credit: { product: 'educativo', amount: 3_000_000, termMonths: 18, monthlyIncome: 2_800_000, monthlyExpenses: 700_000 },
  },
  {
    email: 'pedro.diaz@correo.co', firstName: 'Pedro', lastName: 'Díaz', doc: '1012345670', city: 'Planeta Rica', channel: 'portal-web',
    credit: { product: 'libre_inversion', amount: 6_000_000, termMonths: 24, monthlyIncome: 4_000_000, monthlyExpenses: 1_800_000 },
  },
  {
    email: 'sofia.castro@correo.co', firstName: 'Sofía', lastName: 'Castro', doc: '1067123458', city: 'Montería', channel: 'app-movil',
    credit: { product: 'libre_inversion', amount: 2_500_000, termMonths: 12, monthlyIncome: 3_200_000, monthlyExpenses: 800_000 },
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function seed(baseUrl, log = console.log) {
  const api = async (method, path, { body, token, channel = 'portal-web' } = {}) => {
    const res = await fetch(`${baseUrl}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Channel': channel, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${path}: ${data?.error || res.status}`);
    return data;
  };
  const waitStatus = async (token, id, statuses, timeout = 20000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const c = await api('GET', `/credits/${id}`, { token });
      if (statuses.includes(c.status)) return c;
      await sleep(300);
    }
    throw new Error(`El crédito ${id} no llegó a ${statuses.join('/')}`);
  };

  async function run(c) {
    await api('POST', '/auth/register', { body: { email: c.email, password: PASSWORD } });
    const first = await api('POST', '/auth/login', { body: { email: c.email, password: PASSWORD, deviceId: crypto.randomUUID() } });
    const { token } = await api('POST', '/auth/mfa', { body: { challengeId: first.challengeId, code: first.demoCode } });
    await api('POST', '/customers', {
      token,
      body: {
        documentType: 'CC', documentNumber: c.doc, firstName: c.firstName, lastName: c.lastName,
        phone: `300${c.doc.slice(-7)}`, birthDate: '1990-06-15', city: c.city, address: 'Calle 27 # 5-40',
        dataConsent: true, livenessVerified: true,
      },
    });
    const credit = await api('POST', '/credits', {
      token, channel: c.channel,
      body: { ...c.credit, purpose: 'Libre inversión', bank: 'Bancolombia', accountType: 'ahorros', accountNumber: `4${c.doc}` },
    });
    const evaluated = await waitStatus(token, credit.id, ['aprobada', 'rechazada', 'revision_manual']);
    if (!c.sign || evaluated.status !== 'aprobada') return;
    const body = { acceptTerms: true };
    if (c.stepUp) {
      const ch = await api('POST', '/auth/step-up', { token, body: {} });
      body.stepUpToken = (await api('POST', '/auth/step-up/verify', { token, body: { challengeId: ch.challengeId, code: ch.demoCode } })).stepUpToken;
    }
    await api('POST', `/credits/${credit.id}/sign`, { token, body, channel: c.channel });
    await waitStatus(token, credit.id, ['desembolsada']);
    for (let i = 1; i <= (c.payments || 0); i++) {
      await api('POST', '/payments', { token, body: { creditId: credit.id }, channel: c.channel });
      const start = Date.now();
      while ((await api('GET', `/credits/${credit.id}`, { token })).paidInstallments < i && Date.now() - start < 10000) await sleep(250);
    }
  }

  log('Cargando datos de demostración…');
  await Promise.all(CLIENTS.map(run));
  log(`Datos de demostración listos: ${CLIENTS.length} clientes (contraseña de todos: ${PASSWORD}).`);
}

module.exports = { seed, CLIENTS, PASSWORD };

if (require.main === module) {
  const { ports } = require('../shared/config');
  seed(`http://127.0.0.1:${ports.gateway}`).catch((err) => {
    console.error('No se pudieron cargar los datos. ¿Está corriendo `npm start`?', err.message);
    process.exit(1);
  });
}
