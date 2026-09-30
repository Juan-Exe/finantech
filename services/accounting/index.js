'use strict';
// Microservicio de Contabilidad.
// Dueño de: asientos contables en partida doble, balance de prueba y estados financieros.
// Ya no recibe archivos planos: es un suscriptor más del bus y contabiliza en el momento del hecho económico.
const crypto = require('node:crypto');
const { createApp, HttpError } = require('../../shared/http');
const { authenticate } = require('../../shared/auth');
const { createStore } = require('../../shared/store');
const { createBusClient } = require('../../shared/bus');
const { ports, STAFF_ROLES } = require('../../shared/config');
const { now } = require('../../shared/util');

const app = createApp('accounting');
const store = createStore('accounting', { entries: [] });
const bus = createBusClient({ service: 'accounting', app, port: ports.accounting });

// Plan Único de Cuentas (extracto simplificado).
const ACCOUNTS = {
  1110: { name: 'Bancos', nature: 'debito' },
  1405: { name: 'Cartera de créditos', nature: 'debito' },
  3105: { name: 'Capital suscrito y pagado', nature: 'credito' },
  4102: { name: 'Ingresos por intereses', nature: 'credito' },
};

function post(description, lines, source = {}) {
  const debit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const credit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  if (debit !== credit) throw new HttpError(500, `Asiento descuadrado: débitos ${debit} ≠ créditos ${credit}`);
  const entry = {
    id: crypto.randomUUID(),
    number: `CE-${String(store.data.entries.length + 1).padStart(6, '0')}`,
    date: now(),
    description,
    lines: lines.map((l) => ({ account: String(l.account), name: ACCOUNTS[l.account].name, debit: l.debit || 0, credit: l.credit || 0 })),
    total: debit,
    ...source,
  };
  store.data.entries.push(entry);
  store.save();
  console.log(`[accounting] ${entry.number} ${description} — $${debit.toLocaleString('es-CO')}`);
  return entry;
}

if (!store.data.entries.length) {
  post('Aporte inicial de capital', [
    { account: 1110, debit: 2_000_000_000 },
    { account: 3105, credit: 2_000_000_000 },
  ], { sourceEvent: 'apertura' });
}

bus.on('disbursement.completed', (event) => {
  const d = event.payload;
  post(`Desembolso crédito ${d.creditId.slice(0, 8)} (ref. ${d.reference})`, [
    { account: 1405, debit: d.amount },
    { account: 1110, credit: d.amount },
  ], { sourceEvent: event.topic, eventId: event.id, creditId: d.creditId });
});

bus.on('payment.received', (event) => {
  const p = event.payload;
  post(`Recaudo cuota ${p.installmentNumber} crédito ${p.creditId.slice(0, 8)} (ref. ${p.reference})`, [
    { account: 1110, debit: p.amount },
    { account: 1405, credit: p.principal },
    { account: 4102, credit: p.interest },
  ], { sourceEvent: event.topic, eventId: event.id, creditId: p.creditId });
});

app.get('/entries', (req) => {
  authenticate(req, STAFF_ROLES);
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  return { total: store.data.entries.length, entries: store.data.entries.slice(-limit).reverse() };
});

app.get('/trial-balance', (req) => {
  authenticate(req, STAFF_ROLES);
  const rows = Object.entries(ACCOUNTS).map(([code, acc]) => {
    let debit = 0;
    let credit = 0;
    for (const e of store.data.entries) {
      for (const l of e.lines) {
        if (l.account === code) {
          debit += l.debit;
          credit += l.credit;
        }
      }
    }
    const balance = acc.nature === 'debito' ? debit - credit : credit - debit;
    return { account: code, name: acc.name, nature: acc.nature, debit, credit, balance };
  });
  const totalDebit = rows.reduce((s, r) => s + r.debit, 0);
  const totalCredit = rows.reduce((s, r) => s + r.credit, 0);
  return { rows, totalDebit, totalCredit, balanced: totalDebit === totalCredit, entries: store.data.entries.length, generatedAt: now() };
});

app.listen(ports.accounting).then(() => bus.start());
