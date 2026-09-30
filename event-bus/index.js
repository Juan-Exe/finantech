'use strict';
// Capa 4 — Bus de eventos (publicación/suscripción).
// Los servicios publican hechos de negocio; el bus los entrega a los suscriptores interesados,
// en orden por suscriptor y con reintentos exponenciales. Ningún servicio conoce a los demás.
const { createApp, reply, assert } = require('../shared/http');
const { authenticate, serviceToken } = require('../shared/auth');
const { createStore } = require('../shared/store');
const { ports } = require('../shared/config');
const { sleep, now } = require('../shared/util');

const app = createApp('event-bus');
const store = createStore('event-bus', { events: [], subscriptions: {} });
const queues = new Map(); // service -> cadena de promesas (entrega ordenada)

const MAX_EVENTS = 1500;
const MAX_ATTEMPTS = 6;

async function deliver(event, sub) {
  const record = (event.deliveries[sub.service] = { status: 'pendiente', attempts: 0 });
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    record.attempts = attempt;
    try {
      const res = await fetch(sub.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceToken('event-bus')}` },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      record.status = 'entregado';
      record.at = now();
      store.save();
      return;
    } catch (err) {
      record.status = attempt === MAX_ATTEMPTS ? 'fallido' : 'reintentando';
      record.lastError = err.message;
      store.save();
      if (attempt < MAX_ATTEMPTS) await sleep(400 * 2 ** (attempt - 1));
    }
  }
  console.warn(`[event-bus] entrega fallida de ${event.topic} a ${sub.service}`);
}

function dispatch(event) {
  for (const sub of Object.values(store.data.subscriptions)) {
    if (!sub.topics.includes(event.topic) && !sub.topics.includes('*')) continue;
    const previous = queues.get(sub.service) || Promise.resolve();
    queues.set(sub.service, previous.then(() => deliver(event, sub)));
  }
}

app.post('/subscriptions', (req) => {
  authenticate(req, ['servicio']);
  const { service, url, topics } = req.body;
  assert(service && url && Array.isArray(topics), 400, 'Suscripción inválida');
  store.data.subscriptions[service] = { service, url, topics, updatedAt: now() };
  store.save();
  return reply(201, store.data.subscriptions[service]);
});

app.get('/subscriptions', (req) => {
  authenticate(req, ['admin', 'servicio']);
  return Object.values(store.data.subscriptions);
});

app.post('/publish', (req) => {
  authenticate(req, ['servicio']);
  const event = req.body;
  assert(event.id && event.topic && event.source, 400, 'Evento inválido');
  if (store.data.events.some((e) => e.id === event.id)) return { status: 'duplicado' };
  const stored = { ...event, receivedAt: now(), deliveries: {} };
  store.data.events.push(stored);
  if (store.data.events.length > MAX_EVENTS) store.data.events.splice(0, store.data.events.length - MAX_EVENTS);
  store.save();
  console.log(`[event-bus] ${event.source} → ${event.topic}`);
  dispatch(stored);
  return reply(202, { status: 'aceptado', id: event.id });
});

app.get('/events', (req) => {
  authenticate(req, ['admin', 'servicio']);
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  let events = store.data.events;
  if (req.query.topic) events = events.filter((e) => e.topic === req.query.topic);
  return { total: events.length, events: events.slice(-limit).reverse() };
});

// Al reiniciar, reintenta las entregas que quedaron pendientes.
setTimeout(() => {
  for (const event of store.data.events.slice(-200)) {
    for (const sub of Object.values(store.data.subscriptions)) {
      const d = event.deliveries[sub.service];
      if (d && d.status !== 'entregado') {
        const previous = queues.get(sub.service) || Promise.resolve();
        queues.set(sub.service, previous.then(() => deliver(event, sub)));
      }
    }
  }
}, 3000);

app.listen(ports.bus);
