'use strict';
// Prueba de extremo a extremo: levanta una instancia aislada (otros puertos y datos temporales)
// y recorre el flujo Cliente → App/Web → Autenticación → Crédito → Evaluación → Aprobación → Desembolso → Contabilidad.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'finantech-e2e-'));
process.env.PORT_OFFSET = '1000';
process.env.DATA_DIR = DATA_DIR;

const { startAll } = require('./start');
const { ports } = require('../shared/config');

const BASE = `http://127.0.0.1:${ports.gateway}/api`;
let passed = 0;
let failed = 0;

async function api(method, p, { body, token, channel = 'portal-web' } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Channel': channel, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
  } else {
    failed += 1;
    console.log(`  \x1b[31m✘ ${name}\x1b[0m ${detail !== undefined ? JSON.stringify(detail) : ''}`);
  }
}

async function waitFor(fn, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function login(email, password) {
  const deviceId = crypto.randomUUID();
  const first = await api('POST', '/auth/login', { body: { email, password, deviceId } });
  if (first.data?.status !== 'mfa_required') return first.data?.token;
  const second = await api('POST', '/auth/mfa', { body: { challengeId: first.data.challengeId, code: first.data.demoCode } });
  return second.data?.token;
}

async function newClient(email, documentNumber) {
  await api('POST', '/auth/register', { body: { email, password: 'Cliente2026' } });
  const token = await login(email, 'Cliente2026');
  const onboarding = await api('POST', '/customers', {
    token,
    body: {
      documentType: 'CC', documentNumber, firstName: 'Prueba', lastName: 'E2E', phone: '3001234567',
      birthDate: '1995-05-10', city: 'Montería', address: 'Calle 1 # 2-3', dataConsent: true, livenessVerified: true,
    },
  });
  return { token, customer: onboarding.data, status: onboarding.status };
}

const creditBody = (overrides = {}) => ({
  product: 'libre_inversion', amount: 5_000_000, termMonths: 24, monthlyIncome: 6_000_000, monthlyExpenses: 1_000_000,
  purpose: 'Estudio', bank: 'Bancolombia', accountType: 'ahorros', accountNumber: '12345678901', ...overrides,
});

const getCredit = (token, id) => api('GET', `/credits/${id}`, { token }).then((r) => r.data);

async function run() {
  const up = await waitFor(async () => {
    try {
      const h = await api('GET', '/health');
      return h.data?.services?.every((s) => s.status === 'UP') && h.data;
    } catch {
      return null;
    }
  }, 20000);
  check('Los 9 componentes y el gateway están arriba', !!up, up);
  await new Promise((r) => setTimeout(r, 1500)); // tiempo para que los servicios se suscriban al bus

  console.log('\n1. Identidad y seguridad');
  check('Sin token el gateway responde 401', (await api('GET', '/credits')).status === 401);
  const client = await newClient('ana@correo.co', '1067123456');
  check('Registro + login con MFA emite token', !!client.token);
  check('Vinculación digital con KYC verificado', client.customer?.kyc?.status === 'verificado', client.customer);
  check('Un cliente no puede ver la contabilidad (403)', (await api('GET', '/accounting/trial-balance', { token: client.token })).status === 403);
  const dup = await newClient('ana2@correo.co', '1067123456');
  check('MDM: un segundo registro con el mismo documento es rechazado (409)', dup.status === 409);
  const sarlaft = await newClient('lista@correo.co', '999123456');
  check('SARLAFT: documento en lista restrictiva → KYC rechazado', sarlaft.customer?.kyc?.status === 'rechazado');

  console.log('\n2. Flujo feliz: aprobación automática → firma → desembolso → contabilidad');
  const sim = await api('GET', '/credits/simulate?product=libre_inversion&amount=5000000&term=24');
  check('Simulador público calcula la cuota', sim.data?.installment > 0, sim.data);
  const created = await api('POST', '/credits', { token: client.token, body: creditBody(), channel: 'app-movil' });
  check('Solicitud radicada (201) y en evaluación', created.status === 201 && created.data.status === 'en_evaluacion', created.data);
  const id = created.data.id;
  const approved = await waitFor(async () => (await getCredit(client.token, id))?.status === 'aprobada');
  check('Evaluación por eventos → aprobada automáticamente', !!approved, await getCredit(client.token, id));
  const signed = await api('POST', `/credits/${id}/sign`, { token: client.token, body: { acceptTerms: true } });
  check('Contrato firmado electrónicamente', signed.data?.status === 'formalizada' && !!signed.data.contract?.signatureHash, signed.data);
  const disbursed = await waitFor(async () => (await getCredit(client.token, id))?.status === 'desembolsada');
  check('Desembolso ejecutado por el bus', !!disbursed);
  const pay = await api('POST', '/payments', { token: client.token, body: { creditId: id } });
  check('Pago de la cuota 1', pay.status === 201, pay.data);
  const paid = await waitFor(async () => (await getCredit(client.token, id))?.paidInstallments === 1);
  check('Créditos actualiza el saldo al consumir payment.received', !!paid);

  console.log('\n3. Revisión manual, rechazo y compensación (saga)');
  const manualClient = await newClient('luis@correo.co', '1067123455');
  const manual = await api('POST', '/credits', { token: manualClient.token, body: creditBody() });
  const inReview = await waitFor(async () => (await getCredit(manualClient.token, manual.data.id))?.status === 'revision_manual');
  check('Historial insuficiente → revisión manual', !!inReview);
  const analyst = await login('analista@finantech.co', 'Analista2026!');
  const review = await api('POST', `/credits/${manual.data.id}/review`, { token: analyst, body: { decision: 'aprobar', note: 'Ingresos soportados' } });
  check('Analista aprueba en revisión manual', review.data?.status === 'aprobada', review.data);
  const customerView = await api('GET', `/customers/${manualClient.customer.id}`, { token: analyst });
  check('Analista ve el documento enmascarado (mínimo privilegio)', customerView.data?.documentNumber?.startsWith('*'), customerView.data);
  await api('POST', `/credits/${manual.data.id}/sign`, { token: manualClient.token, body: { acceptTerms: true } });

  const badClient = await newClient('pedro@correo.co', '1067123450');
  const bad = await api('POST', '/credits', { token: badClient.token, body: creditBody() });
  const rejected = await waitFor(async () => (await getCredit(badClient.token, bad.data.id))?.status === 'rechazada');
  check('Reporte negativo en central → rechazo automático', !!rejected);

  const sagaClient = await newClient('sofia@correo.co', '1067123457');
  const saga = await api('POST', '/credits', { token: sagaClient.token, body: creditBody({ accountNumber: '11112222000' }) });
  await waitFor(async () => (await getCredit(sagaClient.token, saga.data.id))?.status === 'aprobada');
  await api('POST', `/credits/${saga.data.id}/sign`, { token: sagaClient.token, body: { acceptTerms: true } });
  const compensated = await waitFor(async () => {
    const c = await getCredit(sagaClient.token, saga.data.id);
    return c?.status === 'aprobada' && c.history.some((h) => h.note?.startsWith('Compensación')) && c;
  });
  check('Desembolso rechazado → evento de compensación devuelve el crédito a "aprobada"', !!compensated);

  console.log('\n4. Seguridad adaptativa (step-up)');
  const bigClient = await newClient('marta@correo.co', '1067123458');
  const big = await api('POST', '/credits', { token: bigClient.token, body: creditBody({ amount: 15_000_000, monthlyIncome: 12_000_000 }) });
  await waitFor(async () => (await getCredit(bigClient.token, big.data.id))?.status === 'aprobada');
  const noStepUp = await api('POST', `/credits/${big.data.id}/sign`, { token: bigClient.token, body: { acceptTerms: true } });
  check('Firmar > $10M sin OTP reforzado es rechazado (403)', noStepUp.status === 403 && noStepUp.data?.details?.stepUpRequired);
  const ch = await api('POST', '/auth/step-up', { token: bigClient.token, body: {} });
  const su = await api('POST', '/auth/step-up/verify', { token: bigClient.token, body: { challengeId: ch.data.challengeId, code: ch.data.demoCode } });
  const withStepUp = await api('POST', `/credits/${big.data.id}/sign`, { token: bigClient.token, body: { acceptTerms: true, stepUpToken: su.data.stepUpToken } });
  check('Con OTP reforzado la firma es aceptada', withStepUp.data?.status === 'formalizada', withStepUp.data);

  console.log('\n5. Contabilidad, analítica y auditoría');
  const admin = await login('admin@finantech.co', 'Admin2026!');
  await waitFor(async () => (await getCredit(bigClient.token, big.data.id))?.status === 'desembolsada');
  await new Promise((r) => setTimeout(r, 800));
  const tb = await api('GET', '/accounting/trial-balance', { token: admin });
  const cartera = tb.data?.rows?.find((r) => r.account === '1405');
  check('Balance de prueba cuadrado (partida doble)', tb.data?.balanced === true, tb.data);
  check('Cartera contabilizada automáticamente = desembolsos − capital recaudado', cartera && cartera.balance === 5_000_000 + 5_000_000 + 15_000_000 - pay.data.principal, cartera);
  const k = await api('GET', '/analytics/kpis', { token: admin });
  check('Bodega analítica: 3 desembolsos y 1 fallo', k.data?.credits?.disbursed === 3 && k.data.credits.disbursementFailures === 1, k.data?.credits);
  const audit = await api('GET', '/audit', { token: admin });
  check('Bitácora de auditoría con cadena de hashes íntegra', audit.data?.integrity?.valid === true && audit.data.total > 0, audit.data?.integrity);
  const events = await api('GET', '/bus/events?limit=500', { token: admin });
  const undelivered = events.data?.events?.filter((e) => Object.values(e.deliveries).some((d) => d.status !== 'entregado'));
  check('Todas las entregas del bus fueron exitosas', undelivered?.length === 0, undelivered?.map((e) => e.topic));
}

const { stop } = startAll({ env: { PORT_OFFSET: '1000', DATA_DIR }, silent: true });
run()
  .catch((err) => {
    failed += 1;
    console.error(err);
  })
  .finally(() => {
    stop();
    console.log(`\n${passed} pruebas exitosas, ${failed} fallidas`);
    setTimeout(() => {
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
      process.exit(failed ? 1 : 0);
    }, 500);
  });
