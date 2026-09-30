'use strict';
// Cliente del bus de eventos.
// - publish(): patrón outbox. El evento se guarda primero en disco y se reintenta hasta que el bus lo acepte.
// - on(): suscripción. El bus entrega por HTTP a POST /events; el consumo es idempotente por id de evento.
const crypto = require('node:crypto');
const { createStore } = require('./store');
const { authenticate, serviceToken } = require('./auth');
const { call } = require('./client');
const { urls } = require('./config');

function createBusClient({ service, app, port }) {
  const store = createStore(`${service}-bus`, { outbox: [], processed: [] });
  const handlers = new Map();
  let registered = false;
  let flushing = false;

  app.post('/events', async (req) => {
    authenticate(req, ['servicio']);
    const event = req.body;
    if (store.data.processed.includes(event.id)) return { status: 'duplicado' };
    const handler = handlers.get(event.topic) || handlers.get('*');
    if (handler) await handler(event);
    store.data.processed.push(event.id);
    if (store.data.processed.length > 5000) store.data.processed.splice(0, 1000);
    store.save();
    return { status: 'procesado' };
  });

  function on(topic, handler) {
    handlers.set(topic, handler);
  }

  async function flushOutbox() {
    if (flushing) return;
    flushing = true;
    try {
      while (store.data.outbox.length) {
        await call(urls.bus, 'POST', '/publish', { body: store.data.outbox[0], token: serviceToken(service) });
        store.data.outbox.shift();
        store.save();
      }
    } catch {
      // El bus no está disponible: el evento permanece en el outbox y se reintenta.
    } finally {
      flushing = false;
    }
  }

  function publish(topic, payload, meta = {}) {
    const event = {
      id: crypto.randomUUID(),
      topic,
      source: service,
      occurredAt: new Date().toISOString(),
      correlationId: meta.correlationId || payload.creditId || null,
      payload,
    };
    store.data.outbox.push(event);
    store.save();
    flushOutbox();
    return event;
  }

  async function register() {
    try {
      await call(urls.bus, 'POST', '/subscriptions', {
        body: { service, url: `http://127.0.0.1:${port}/events`, topics: [...handlers.keys()] },
        token: serviceToken(service),
      });
      if (!registered) console.log(`[${service}] suscrito al bus: ${[...handlers.keys()].join(', ')}`);
      registered = true;
    } catch {
      registered = false;
    }
  }

  function start() {
    if (handlers.size) register();
    flushOutbox();
    // Re-suscripción periódica (idempotente) para recuperarse si el bus se reinicia.
    setInterval(() => {
      flushOutbox();
      if (handlers.size) register();
    }, 4000).unref();
  }

  return { on, publish, start };
}

module.exports = { createBusClient };
