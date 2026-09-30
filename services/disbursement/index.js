'use strict';
// Microservicio de Desembolso y pagos.
// Dueño de: órdenes de desembolso, recaudo de cuotas y conciliación con entidades externas (ACH/PSE simulados).
// No lleva los libros contables: publica los hechos y Contabilidad los registra.
const crypto = require('node:crypto');
const { createApp, reply, assert, required, HttpError } = require('../../shared/http');
const { authenticate, bearer } = require('../../shared/auth');
const { createStore } = require('../../shared/store');
const { createBusClient } = require('../../shared/bus');
const { call } = require('../../shared/client');
const { ports, urls, STAFF_ROLES } = require('../../shared/config');
const { sleep, now, maskTail } = require('../../shared/util');

const app = createApp('disbursement');
const store = createStore('disbursement', { disbursements: {}, payments: {} });
const bus = createBusClient({ service: 'disbursement', app, port: ports.disbursement });

const reference = (prefix) => `${prefix}-${Date.now().toString().slice(-8)}${crypto.randomInt(100, 999)}`;
const inFlight = new Set();

bus.on('credit.formalized', async (event) => {
  const p = event.payload;
  const order = {
    id: crypto.randomUUID(),
    creditId: p.creditId,
    customerId: p.customerId,
    amount: p.amount,
    bank: p.bank,
    accountType: p.accountType,
    accountMasked: maskTail(p.accountNumber),
    status: 'en_proceso',
    createdAt: now(),
  };
  store.data.disbursements[order.id] = order;
  store.save();

  await sleep(1500); // tiempo de respuesta de la red ACH (simulado)

  // Datos de prueba: una cuenta terminada en 000 es rechazada por el banco destino.
  if (String(p.accountNumber).endsWith('000')) {
    order.status = 'rechazado';
    order.reason = 'Cuenta destino inexistente (rechazo ACH simulado)';
    order.completedAt = now();
    store.save();
    bus.publish('disbursement.failed', { disbursementId: order.id, creditId: p.creditId, customerId: p.customerId, amount: p.amount, reason: order.reason });
    return;
  }
  order.status = 'completado';
  order.reference = reference('ACH');
  order.completedAt = now();
  store.save();
  bus.publish('disbursement.completed', {
    disbursementId: order.id,
    creditId: p.creditId,
    customerId: p.customerId,
    amount: p.amount,
    bank: p.bank,
    accountMasked: order.accountMasked,
    reference: order.reference,
  });
});

// Pago de la siguiente cuota (recaudo por PSE simulado).
app.post('/payments', async (req) => {
  const claims = authenticate(req, ['cliente']);
  required(req.body, ['creditId']);
  const { creditId } = req.body;
  // Consulta al dueño del crédito, con el token del cliente (Créditos valida que le pertenezca).
  const credit = await call(urls.credits, 'GET', `/credits/${encodeURIComponent(creditId)}`, { token: bearer(req) });
  assert(credit.status === 'desembolsada', 409, 'El crédito no tiene cuotas pendientes de pago');
  const next = credit.schedule.find((r) => !r.paidAt);
  assert(next, 409, 'No hay cuotas pendientes');
  const key = `${creditId}#${next.number}`;
  const alreadyPaid = Object.values(store.data.payments).some((p) => p.creditId === creditId && p.installmentNumber === next.number);
  if (inFlight.has(key) || alreadyPaid) throw new HttpError(409, 'Esta cuota ya está siendo procesada');
  inFlight.add(key);
  try {
    const payment = {
      id: crypto.randomUUID(),
      creditId,
      customerId: credit.customerId,
      userId: claims.sub,
      installmentNumber: next.number,
      amount: next.payment,
      principal: next.principal,
      interest: next.interest,
      method: 'PSE (simulado)',
      reference: reference('PSE'),
      createdAt: now(),
    };
    store.data.payments[payment.id] = payment;
    store.save();
    bus.publish('payment.received', {
      paymentId: payment.id,
      creditId,
      customerId: payment.customerId,
      installmentNumber: payment.installmentNumber,
      amount: payment.amount,
      principal: payment.principal,
      interest: payment.interest,
      reference: payment.reference,
    });
    return reply(201, payment);
  } finally {
    setTimeout(() => inFlight.delete(key), 3000);
  }
});

app.get('/payments', (req) => {
  const claims = authenticate(req, ['cliente', ...STAFF_ROLES]);
  let list = Object.values(store.data.payments);
  if (claims.role === 'cliente') list = list.filter((p) => p.userId === claims.sub);
  if (req.query.creditId) list = list.filter((p) => p.creditId === req.query.creditId);
  return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
});

app.get('/disbursements', (req) => {
  authenticate(req, STAFF_ROLES);
  return Object.values(store.data.disbursements).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
});

app.listen(ports.disbursement).then(() => bus.start());
