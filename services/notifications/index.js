'use strict';
// Microservicio de Notificaciones.
// Entrega mensajes por correo, SMS y push (simulados) en cada hito del proceso.
// No decide el contenido de negocio ni guarda datos de contacto: los consulta al servicio de Clientes.
const crypto = require('node:crypto');
const { createApp } = require('../../shared/http');
const { authenticate, serviceToken, bearer } = require('../../shared/auth');
const { createStore } = require('../../shared/store');
const { createBusClient } = require('../../shared/bus');
const { call } = require('../../shared/client');
const { ports, urls } = require('../../shared/config');
const { now, maskTail, maskEmail } = require('../../shared/util');

const app = createApp('notifications');
const store = createStore('notifications', { notifications: [] });
const bus = createBusClient({ service: 'notifications', app, port: ports.notifications });

const money = (n) => `$${Number(n).toLocaleString('es-CO')}`;

const TEMPLATES = {
  'customer.registered': (p) =>
    p.kycStatus === 'verificado'
      ? { title: '¡Bienvenido a FinanTech!', body: 'Tu vinculación digital fue exitosa. Ya puedes solicitar tu crédito.', level: 'ok' }
      : { title: 'Vinculación no aprobada', body: 'No pudimos completar tu vinculación por políticas de cumplimiento (SARLAFT).', level: 'danger' },
  'credit.requested': (p) => ({ title: 'Solicitud recibida', body: `Recibimos tu solicitud por ${money(p.amount)}. La estamos evaluando.`, level: 'info' }),
  'credit.approved': (p) => ({ title: '¡Crédito aprobado!', body: `Tu crédito por ${money(p.amount)} fue aprobado. Firma el contrato para recibir el dinero.`, level: 'ok' }),
  'credit.rejected': () => ({ title: 'Solicitud no aprobada', body: 'Tu solicitud no cumple nuestras políticas de crédito en este momento.', level: 'danger' }),
  'credit.manual_review': () => ({ title: 'Solicitud en revisión', body: 'Un analista está revisando tu solicitud. Te avisaremos pronto.', level: 'warn' }),
  'credit.formalized': () => ({ title: 'Contrato firmado', body: 'Firmaste tu contrato electrónicamente. Estamos procesando el desembolso.', level: 'info' }),
  'disbursement.completed': (p) => ({ title: 'Dinero desembolsado', body: `Transferimos ${money(p.amount)} a tu cuenta ${p.bank} ${p.accountMasked}.`, level: 'ok' }),
  'disbursement.failed': (p) => ({ title: 'No pudimos desembolsar', body: `${p.reason}. Actualiza tu cuenta destino y firma de nuevo.`, level: 'danger' }),
  'payment.received': (p) => ({ title: 'Pago recibido', body: `Registramos el pago de tu cuota ${p.installmentNumber} por ${money(p.amount)}.`, level: 'ok' }),
  'credit.paid_off': () => ({ title: '¡Crédito pagado!', body: 'Cancelaste la totalidad de tu crédito. ¡Gracias por confiar en FinanTech!', level: 'ok' }),
};

for (const [topic, template] of Object.entries(TEMPLATES)) {
  bus.on(topic, async (event) => {
    const customer = await call(urls.customers, 'GET', `/customers/${event.payload.customerId}`, { token: serviceToken('notifications') });
    const message = template(event.payload);
    const notification = {
      id: crypto.randomUUID(),
      customerId: customer.id,
      topic,
      ...message,
      creditId: event.payload.creditId || null,
      channels: [
        { type: 'correo', to: maskEmail(customer.email) },
        { type: 'sms', to: maskTail(customer.phone) },
        { type: 'push', to: 'app móvil' },
      ],
      read: false,
      createdAt: now(),
    };
    store.data.notifications.push(notification);
    if (store.data.notifications.length > 3000) store.data.notifications.splice(0, 500);
    store.save();
    console.log(`[notifications] ✉ ${message.title} → ${maskEmail(customer.email)}`);
  });
}

app.get('/notifications/me', async (req) => {
  authenticate(req, ['cliente']);
  const customer = await call(urls.customers, 'GET', '/customers/me', { token: bearer(req) });
  return store.data.notifications.filter((n) => n.customerId === customer.id).reverse().slice(0, 50);
});

app.post('/notifications/me/read', async (req) => {
  authenticate(req, ['cliente']);
  const customer = await call(urls.customers, 'GET', '/customers/me', { token: bearer(req) });
  let count = 0;
  for (const n of store.data.notifications) {
    if (n.customerId === customer.id && !n.read) {
      n.read = true;
      count += 1;
    }
  }
  store.save();
  return { marked: count };
});

app.get('/notifications', (req) => {
  authenticate(req, ['admin']);
  return store.data.notifications.slice(-100).reverse();
});

app.listen(ports.notifications).then(() => bus.start());
