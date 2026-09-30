'use strict';
// Microservicio de Créditos.
// Dueño de: solicitudes, contratos, planes de amortización y saldos.
// No decide aprobaciones (Evaluación) ni ejecuta pagos (Desembolso y pagos).
// Guarda solo la referencia al cliente (customerId); sus datos se consultan al servicio de Clientes.
const crypto = require('node:crypto');
const { createApp, reply, assert, required, HttpError } = require('../../shared/http');
const { authenticate, bearer } = require('../../shared/auth');
const { verify } = require('../../shared/jwt');
const { createStore } = require('../../shared/store');
const { createBusClient } = require('../../shared/bus');
const { call } = require('../../shared/client');
const { ports, urls, JWT_SECRET, STAFF_ROLES } = require('../../shared/config');
const { now, maskTail } = require('../../shared/util');

const app = createApp('credits');
const store = createStore('credits', { credits: {} });
const bus = createBusClient({ service: 'credits', app, port: ports.credits });

const PRODUCTS = {
  libre_inversion: { id: 'libre_inversion', name: 'Libre inversión', monthlyRate: 0.0189, minAmount: 1_000_000, maxAmount: 50_000_000, minTerm: 6, maxTerm: 60 },
  educativo: { id: 'educativo', name: 'Crédito educativo', monthlyRate: 0.0115, minAmount: 500_000, maxAmount: 30_000_000, minTerm: 6, maxTerm: 36 },
  vehiculo: { id: 'vehiculo', name: 'Vehículo', monthlyRate: 0.0145, minAmount: 10_000_000, maxAmount: 150_000_000, minTerm: 12, maxTerm: 72 },
};
const BANKS = ['Bancolombia', 'Banco de Bogotá', 'Davivienda', 'BBVA', 'Banco de Occidente', 'Nequi', 'Daviplata'];
const STEP_UP_THRESHOLD = 10_000_000;
const IN_PROGRESS = ['en_evaluacion', 'revision_manual', 'aprobada', 'formalizada'];

// ---------- Cálculo financiero (sistema francés, cuota fija) ----------
const annualRate = (i) => Math.pow(1 + i, 12) - 1;
const installmentFor = (amount, i, n) => Math.round((amount * i) / (1 - Math.pow(1 + i, -n)));

function buildSchedule(amount, i, n, start = new Date()) {
  const payment = installmentFor(amount, i, n);
  let balance = amount;
  const rows = [];
  for (let k = 1; k <= n; k++) {
    const interest = Math.round(balance * i);
    const principal = k === n ? balance : payment - interest;
    balance -= principal;
    const due = new Date(start);
    due.setMonth(due.getMonth() + k);
    rows.push({ number: k, dueDate: due.toISOString().slice(0, 10), payment: principal + interest, principal, interest, balance, paidAt: null });
  }
  return rows;
}

function validateTerms(productId, amount, term) {
  const product = PRODUCTS[productId];
  assert(product, 400, 'Producto no válido');
  assert(Number.isFinite(amount) && amount >= product.minAmount && amount <= product.maxAmount, 400,
    `El monto para ${product.name} debe estar entre $${product.minAmount.toLocaleString('es-CO')} y $${product.maxAmount.toLocaleString('es-CO')}`);
  assert(Number.isInteger(term) && term >= product.minTerm && term <= product.maxTerm, 400,
    `El plazo para ${product.name} debe estar entre ${product.minTerm} y ${product.maxTerm} meses`);
  return product;
}

function transition(credit, status, note, by) {
  credit.status = status;
  credit.updatedAt = now();
  credit.history.push({ status, at: now(), note: note || null, by: by || 'sistema' });
  store.save();
}

function view(credit, claims) {
  const isOwner = claims.role === 'cliente';
  return {
    ...credit,
    disbursementAccount: { ...credit.disbursementAccount, accountNumber: isOwner || claims.role === 'servicio' ? credit.disbursementAccount.accountNumber : maskTail(credit.disbursementAccount.accountNumber) },
    requiresStepUp: credit.amount > STEP_UP_THRESHOLD,
  };
}

function getOwned(req, roles = ['cliente', ...STAFF_ROLES, 'servicio']) {
  const claims = authenticate(req, roles);
  const credit = store.data.credits[req.params.id];
  assert(credit, 404, 'Crédito no encontrado');
  if (claims.role === 'cliente') assert(credit.userId === claims.sub, 403, 'Este crédito no le pertenece');
  return { claims, credit };
}

// ---------- API ----------
app.get('/products', () => ({ products: Object.values(PRODUCTS).map((p) => ({ ...p, annualRate: annualRate(p.monthlyRate) })), banks: BANKS, stepUpThreshold: STEP_UP_THRESHOLD }));

app.get('/credits/simulate', (req) => {
  const amount = Number(req.query.amount);
  const term = Number(req.query.term);
  const product = validateTerms(req.query.product || 'libre_inversion', amount, term);
  const installment = installmentFor(amount, product.monthlyRate, term);
  return {
    product: product.id,
    amount,
    termMonths: term,
    monthlyRate: product.monthlyRate,
    annualRate: annualRate(product.monthlyRate),
    installment,
    totalPaid: installment * term,
    totalInterest: installment * term - amount,
  };
});

app.post('/credits', async (req) => {
  const claims = authenticate(req, ['cliente']);
  const b = req.body;
  required(b, ['product', 'amount', 'termMonths', 'monthlyIncome', 'monthlyExpenses', 'bank', 'accountType', 'accountNumber']);
  const amount = Math.round(Number(b.amount));
  const term = Number(b.termMonths);
  const product = validateTerms(b.product, amount, term);
  const monthlyIncome = Math.round(Number(b.monthlyIncome));
  const monthlyExpenses = Math.round(Number(b.monthlyExpenses));
  assert(monthlyIncome > 0, 400, 'Los ingresos mensuales deben ser mayores a cero');
  assert(monthlyExpenses >= 0, 400, 'Los gastos mensuales no pueden ser negativos');
  assert(BANKS.includes(b.bank), 400, 'Entidad bancaria no válida');
  assert(['ahorros', 'corriente'].includes(b.accountType), 400, 'Tipo de cuenta no válido');
  assert(/^\d{6,16}$/.test(String(b.accountNumber)), 400, 'Número de cuenta inválido (6 a 16 dígitos)');

  // El dato del cliente se consulta a su dueño, no se copia.
  let customer;
  try {
    customer = await call(urls.customers, 'GET', '/customers/me', { token: bearer(req) });
  } catch (err) {
    if (err.status === 404) throw new HttpError(409, 'Debe completar la vinculación digital antes de solicitar un crédito');
    throw err;
  }
  assert(customer.kyc.status === 'verificado', 422, 'Su vinculación no fue aprobada por las políticas de cumplimiento (SARLAFT)');
  const open = Object.values(store.data.credits).find((c) => c.customerId === customer.id && IN_PROGRESS.includes(c.status));
  assert(!open, 409, 'Ya tiene una solicitud en curso. Finalícela antes de radicar otra.');

  const installment = installmentFor(amount, product.monthlyRate, term);
  const credit = {
    id: crypto.randomUUID(),
    number: `FT-${String(Object.keys(store.data.credits).length + 1).padStart(6, '0')}`,
    customerId: customer.id,
    userId: claims.sub,
    channel: req.headers['x-channel'] || 'api',
    product: product.id,
    productName: product.name,
    amount,
    termMonths: term,
    monthlyRate: product.monthlyRate,
    annualRate: annualRate(product.monthlyRate),
    installment,
    monthlyIncome,
    monthlyExpenses,
    purpose: b.purpose || 'No especificado',
    disbursementAccount: { bank: b.bank, accountType: b.accountType, accountNumber: String(b.accountNumber) },
    status: 'radicada',
    evaluation: null,
    contract: null,
    schedule: [],
    balance: 0,
    paidInstallments: 0,
    history: [],
    createdAt: now(),
    updatedAt: now(),
  };
  store.data.credits[credit.id] = credit;
  transition(credit, 'radicada', `Solicitud radicada por canal ${credit.channel}`, claims.email);
  transition(credit, 'en_evaluacion', 'Enviada al motor de evaluación de riesgo');

  bus.publish('credit.requested', {
    creditId: credit.id,
    customerId: credit.customerId,
    product: credit.product,
    amount,
    termMonths: term,
    installment,
    monthlyIncome,
    monthlyExpenses,
    channel: credit.channel,
  });
  return reply(201, view(credit, claims));
});

app.get('/credits', (req) => {
  const claims = authenticate(req, ['cliente', ...STAFF_ROLES]);
  let list = Object.values(store.data.credits);
  if (claims.role === 'cliente') list = list.filter((c) => c.userId === claims.sub);
  if (req.query.status) list = list.filter((c) => c.status === req.query.status);
  return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((c) => view(c, claims));
});

app.get('/credits/:id', (req) => {
  const { claims, credit } = getOwned(req);
  return view(credit, claims);
});

// Revisión manual por analista (casos fuera de la política automática).
app.post('/credits/:id/review', (req) => {
  const { claims, credit } = getOwned(req, ['analista', 'admin']);
  assert(credit.status === 'revision_manual', 409, 'El crédito no está pendiente de revisión manual');
  const { decision, note } = req.body;
  assert(['aprobar', 'rechazar'].includes(decision), 400, 'La decisión debe ser "aprobar" o "rechazar"');
  assert(decision === 'aprobar' || (note && String(note).trim().length >= 5), 400, 'Indique el motivo del rechazo');
  if (decision === 'aprobar') {
    transition(credit, 'aprobada', note || 'Aprobado en revisión manual', claims.email);
    bus.publish('credit.approved', { creditId: credit.id, customerId: credit.customerId, amount: credit.amount, automatic: false, reviewedBy: claims.email });
  } else {
    transition(credit, 'rechazada', note, claims.email);
    bus.publish('credit.rejected', { creditId: credit.id, customerId: credit.customerId, amount: credit.amount, automatic: false, reasons: [note], reviewedBy: claims.email });
  }
  return view(credit, claims);
});

// Formalización: firma electrónica. Montos altos exigen autenticación reforzada (seguridad adaptativa).
app.post('/credits/:id/sign', (req) => {
  const { claims, credit } = getOwned(req, ['cliente']);
  assert(credit.status === 'aprobada', 409, 'Solo se pueden firmar créditos aprobados');
  assert(req.body.acceptTerms === true, 422, 'Debe aceptar las condiciones del contrato');
  let method = 'Sesión autenticada con MFA';
  if (credit.amount > STEP_UP_THRESHOLD) {
    const stepUp = verify(req.body.stepUpToken, JWT_SECRET);
    if (!stepUp || stepUp.typ !== 'step-up' || stepUp.sub !== claims.sub) {
      throw new HttpError(403, 'Este monto requiere verificación reforzada (OTP) para firmar', { stepUpRequired: true });
    }
    method = 'Autenticación reforzada (OTP de un solo uso)';
  }
  const signedAt = now();
  const document = JSON.stringify({ credit: credit.number, amount: credit.amount, term: credit.termMonths, rate: credit.monthlyRate, installment: credit.installment, signer: claims.sub, signedAt });
  credit.contract = {
    version: 'contrato-credito-v1',
    signedAt,
    signer: claims.email,
    method,
    ip: req.headers['x-forwarded-for'] || null,
    signatureHash: crypto.createHash('sha256').update(document).digest('hex'),
  };
  transition(credit, 'formalizada', `Contrato firmado electrónicamente (${method})`, claims.email);
  bus.publish('credit.formalized', {
    creditId: credit.id,
    customerId: credit.customerId,
    amount: credit.amount,
    ...credit.disbursementAccount,
  });
  return view(credit, claims);
});

// Tras un desembolso fallido (compensación), el cliente puede corregir la cuenta destino.
app.patch('/credits/:id/account', (req) => {
  const { claims, credit } = getOwned(req, ['cliente']);
  assert(credit.status === 'aprobada', 409, 'Solo puede cambiar la cuenta antes de la formalización');
  const { bank, accountType, accountNumber } = req.body;
  assert(BANKS.includes(bank), 400, 'Entidad bancaria no válida');
  assert(['ahorros', 'corriente'].includes(accountType), 400, 'Tipo de cuenta no válido');
  assert(/^\d{6,16}$/.test(String(accountNumber)), 400, 'Número de cuenta inválido');
  credit.disbursementAccount = { bank, accountType, accountNumber: String(accountNumber) };
  credit.updatedAt = now();
  store.save();
  return view(credit, claims);
});

// ---------- Consumo de eventos ----------
bus.on('evaluation.completed', (event) => {
  const e = event.payload;
  const credit = store.data.credits[e.creditId];
  if (!credit || credit.status !== 'en_evaluacion') return;
  credit.evaluation = e;
  const base = { creditId: credit.id, customerId: credit.customerId, amount: credit.amount };
  if (e.decision === 'aprobado') {
    transition(credit, 'aprobada', `Aprobación automática. Puntaje ${e.score}`, 'motor-evaluacion');
    bus.publish('credit.approved', { ...base, automatic: true, score: e.score });
  } else if (e.decision === 'rechazado') {
    transition(credit, 'rechazada', e.reasons.join('. '), 'motor-evaluacion');
    bus.publish('credit.rejected', { ...base, automatic: true, reasons: e.reasons });
  } else {
    transition(credit, 'revision_manual', 'Fuera de la política automática: se deriva a un analista', 'motor-evaluacion');
    bus.publish('credit.manual_review', { ...base, score: e.score, reasons: e.reasons });
  }
});

bus.on('disbursement.completed', (event) => {
  const d = event.payload;
  const credit = store.data.credits[d.creditId];
  if (!credit || credit.status !== 'formalizada') return;
  credit.schedule = buildSchedule(credit.amount, credit.monthlyRate, credit.termMonths);
  credit.balance = credit.amount;
  credit.disbursedAt = now();
  credit.disbursementReference = d.reference;
  transition(credit, 'desembolsada', `Desembolso realizado a ${d.bank} ${d.accountMasked} (ref. ${d.reference})`, 'servicio-desembolso');
});

// Patrón saga: si el desembolso falla, se compensa devolviendo el crédito a "aprobada" para reintentar.
bus.on('disbursement.failed', (event) => {
  const d = event.payload;
  const credit = store.data.credits[d.creditId];
  if (!credit || credit.status !== 'formalizada') return;
  credit.contract = null;
  transition(credit, 'aprobada', `Compensación: ${d.reason}. Actualice la cuenta destino y firme nuevamente.`, 'servicio-desembolso');
});

bus.on('payment.received', (event) => {
  const p = event.payload;
  const credit = store.data.credits[p.creditId];
  if (!credit || credit.status !== 'desembolsada') return;
  const row = credit.schedule.find((r) => r.number === p.installmentNumber);
  if (!row || row.paidAt) return;
  row.paidAt = now();
  row.paymentReference = p.reference;
  credit.paidInstallments += 1;
  credit.balance = Math.max(0, credit.balance - p.principal);
  credit.updatedAt = now();
  store.save();
  if (credit.paidInstallments === credit.termMonths) {
    transition(credit, 'pagada', 'Crédito cancelado en su totalidad', 'sistema');
    bus.publish('credit.paid_off', { creditId: credit.id, customerId: credit.customerId, amount: credit.amount });
  }
});

app.listen(ports.credits).then(() => bus.start());
