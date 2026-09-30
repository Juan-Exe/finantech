'use strict';
// Plataforma analítica (bodega de datos).
// Se alimenta de TODO el flujo de eventos del bus; las consultas analíticas nunca tocan
// las bases transaccionales de los microservicios.
const { createApp } = require('../../shared/http');
const { authenticate } = require('../../shared/auth');
const { createStore } = require('../../shared/store');
const { createBusClient } = require('../../shared/bus');
const { ports, STAFF_ROLES } = require('../../shared/config');

const app = createApp('analytics');
const store = createStore('analytics', { facts: [] });
const bus = createBusClient({ service: 'analytics', app, port: ports.analytics });

bus.on('*', (event) => {
  store.data.facts.push({ id: event.id, topic: event.topic, source: event.source, at: event.occurredAt, payload: event.payload });
  store.save();
});

function kpis() {
  const facts = store.data.facts;
  const of = (topic) => facts.filter((f) => f.topic === topic);
  const sum = (list, field) => list.reduce((s, f) => s + (Number(f.payload[field]) || 0), 0);

  const requested = of('credit.requested');
  const approved = of('credit.approved');
  const rejected = of('credit.rejected');
  const manual = of('credit.manual_review');
  const formalized = of('credit.formalized');
  const disbursed = of('disbursement.completed');
  const failed = of('disbursement.failed');
  const payments = of('payment.received');
  const registered = of('customer.registered');

  const autoDecisions = approved.filter((f) => f.payload.automatic).length + rejected.filter((f) => f.payload.automatic).length;
  const decisions = approved.length + rejected.length;

  const requestedAt = new Map(requested.map((f) => [f.payload.creditId, new Date(f.at).getTime()]));
  const cycleTimes = disbursed
    .filter((f) => requestedAt.has(f.payload.creditId))
    .map((f) => (new Date(f.at).getTime() - requestedAt.get(f.payload.creditId)) / 1000);

  const principalCollected = sum(payments, 'principal');
  const disbursedAmount = sum(disbursed, 'amount');

  const byProduct = {};
  for (const f of requested) {
    const p = (byProduct[f.payload.product] ||= { product: f.payload.product, requests: 0, amount: 0 });
    p.requests += 1;
    p.amount += f.payload.amount;
  }
  const byChannel = {};
  for (const f of requested) byChannel[f.payload.channel || 'api'] = (byChannel[f.payload.channel || 'api'] || 0) + 1;

  return {
    customers: { registered: registered.length, kycRejected: registered.filter((f) => f.payload.kycStatus !== 'verificado').length },
    credits: {
      requested: requested.length,
      amountRequested: sum(requested, 'amount'),
      approvedAutomatic: approved.filter((f) => f.payload.automatic).length,
      approvedManual: approved.filter((f) => !f.payload.automatic).length,
      rejected: rejected.length,
      sentToManualReview: manual.length,
      formalized: formalized.length,
      disbursed: disbursed.length,
      disbursementFailures: failed.length,
      paidOff: of('credit.paid_off').length,
    },
    automaticDecisionRate: decisions ? autoDecisions / decisions : 0,
    approvalRate: decisions ? approved.length / decisions : 0,
    avgRequestToDisbursementSeconds: cycleTimes.length ? cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length : null,
    money: {
      disbursed: disbursedAmount,
      collected: sum(payments, 'amount'),
      principalCollected,
      interestIncome: sum(payments, 'interest'),
      portfolio: disbursedAmount - principalCollected,
    },
    funnel: [
      { stage: 'Solicitadas', value: requested.length },
      { stage: 'Aprobadas', value: approved.length },
      { stage: 'Formalizadas', value: new Set(formalized.map((f) => f.payload.creditId)).size },
      { stage: 'Desembolsadas', value: disbursed.length },
    ],
    byProduct: Object.values(byProduct),
    byChannel,
    events: facts.length,
    recent: facts.slice(-12).reverse().map((f) => ({ topic: f.topic, source: f.source, at: f.at })),
    generatedAt: new Date().toISOString(),
  };
}

app.get('/kpis', (req) => {
  authenticate(req, STAFF_ROLES);
  return kpis();
});

app.listen(ports.analytics).then(() => bus.start());
