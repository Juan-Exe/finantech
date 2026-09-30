'use strict';
// Microservicio de Clientes — fuente única de verdad del cliente (registro maestro / MDM).
// Dueño de: identidad del cliente, datos personales y de contacto, resultado KYC/SARLAFT y consentimiento.
// No calcula riesgo ni evalúa capacidad de pago.
const crypto = require('node:crypto');
const { createApp, reply, assert, required } = require('../../shared/http');
const { authenticate } = require('../../shared/auth');
const { createStore } = require('../../shared/store');
const { createBusClient } = require('../../shared/bus');
const { ports, STAFF_ROLES } = require('../../shared/config');
const { now, maskTail, maskEmail } = require('../../shared/util');

const app = createApp('customers');
const store = createStore('customers', { customers: {} });
const bus = createBusClient({ service: 'customers', app, port: ports.customers });

const DOCUMENT_TYPES = ['CC', 'CE', 'PA'];
const EDITABLE = ['phone', 'address', 'city'];

// Lista restrictiva simulada (SARLAFT): documentos que inician por 999.
const sarlaftCheck = (documentNumber) => (String(documentNumber).startsWith('999') ? 'coincidencia' : 'sin_coincidencia');

const all = () => Object.values(store.data.customers);
const byUser = (userId) => all().find((c) => c.userId === userId);

function ageInYears(birthDate) {
  const b = new Date(birthDate);
  const t = new Date();
  let age = t.getFullYear() - b.getFullYear();
  if (t.getMonth() < b.getMonth() || (t.getMonth() === b.getMonth() && t.getDate() < b.getDate())) age -= 1;
  return age;
}

// Mínimo privilegio: el analista ve los datos sensibles enmascarados.
function view(customer, role) {
  if (role !== 'analista') return customer;
  return {
    ...customer,
    documentNumber: maskTail(customer.documentNumber),
    email: maskEmail(customer.email),
    phone: maskTail(customer.phone),
    address: '*** (dato protegido)',
  };
}

app.post('/customers', (req) => {
  const claims = authenticate(req, ['cliente']);
  assert(!byUser(claims.sub), 409, 'Ya completó su vinculación digital');
  const b = req.body;
  required(b, ['documentType', 'documentNumber', 'firstName', 'lastName', 'phone', 'birthDate', 'city', 'address']);
  assert(DOCUMENT_TYPES.includes(b.documentType), 400, 'Tipo de documento inválido');
  const documentNumber = String(b.documentNumber).replace(/\D/g, '');
  assert(documentNumber.length >= 5 && documentNumber.length <= 12, 400, 'Número de documento inválido');
  assert(/^\d{7,12}$/.test(String(b.phone).replace(/\D/g, '')), 400, 'Teléfono inválido');
  assert(!Number.isNaN(Date.parse(b.birthDate)), 400, 'Fecha de nacimiento inválida');
  assert(ageInYears(b.birthDate) >= 18, 422, 'Debe ser mayor de edad para vincularse');
  assert(b.dataConsent === true, 422, 'Debe autorizar el tratamiento de datos personales (Ley 1581 de 2012)');
  assert(b.livenessVerified === true, 422, 'Debe completar la validación biométrica con prueba de vida');

  // Gestión de datos maestros: un único registro por documento en toda la organización.
  const duplicate = all().find((c) => c.documentType === b.documentType && c.documentNumber === documentNumber);
  assert(!duplicate, 409, 'Ya existe un cliente con este documento. FinanTech mantiene un único registro maestro por persona.');

  const sarlaft = sarlaftCheck(documentNumber);
  const customer = {
    id: crypto.randomUUID(),
    userId: claims.sub,
    documentType: b.documentType,
    documentNumber,
    firstName: String(b.firstName).trim(),
    lastName: String(b.lastName).trim(),
    email: claims.email,
    phone: String(b.phone).replace(/\D/g, ''),
    birthDate: b.birthDate,
    city: String(b.city).trim(),
    address: String(b.address).trim(),
    kyc: {
      status: sarlaft === 'coincidencia' ? 'rechazado' : 'verificado',
      sarlaft,
      livenessVerified: true,
      documentValidated: true,
      checkedAt: now(),
    },
    consent: { accepted: true, policy: 'Ley 1581 de 2012 — Habeas Data', at: now() },
    createdAt: now(),
    updatedAt: now(),
  };
  store.data.customers[customer.id] = customer;
  store.save();

  // Minimización: el evento no transporta datos personales, solo la referencia al registro maestro.
  bus.publish('customer.registered', { customerId: customer.id, city: customer.city, kycStatus: customer.kyc.status });
  return reply(201, customer);
});

app.get('/customers/me', (req) => {
  const claims = authenticate(req, ['cliente']);
  const customer = byUser(claims.sub);
  assert(customer, 404, 'Aún no ha completado la vinculación digital');
  return customer;
});

app.patch('/customers/me', (req) => {
  const claims = authenticate(req, ['cliente']);
  const customer = byUser(claims.sub);
  assert(customer, 404, 'Aún no ha completado la vinculación digital');
  const changed = EDITABLE.filter((f) => req.body[f] !== undefined && String(req.body[f]).trim() !== '');
  assert(changed.length, 400, 'No hay cambios para aplicar');
  if (changed.includes('phone')) assert(/^\d{7,12}$/.test(String(req.body.phone).replace(/\D/g, '')), 400, 'Teléfono inválido');
  for (const f of changed) customer[f] = f === 'phone' ? String(req.body.phone).replace(/\D/g, '') : String(req.body[f]).trim();
  customer.updatedAt = now();
  store.save();
  bus.publish('customer.updated', { customerId: customer.id, fields: changed });
  return customer;
});

app.get('/customers', (req) => {
  const claims = authenticate(req, STAFF_ROLES);
  const q = String(req.query.q || '').toLowerCase();
  const list = all()
    .filter((c) => !q || `${c.firstName} ${c.lastName} ${c.documentNumber} ${c.email}`.toLowerCase().includes(q))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return list.map((c) => view(c, claims.role));
});

app.get('/customers/:id', (req) => {
  const claims = authenticate(req, [...STAFF_ROLES, 'servicio', 'cliente']);
  const customer = store.data.customers[req.params.id];
  assert(customer, 404, 'Cliente no encontrado');
  if (claims.role === 'cliente') assert(customer.userId === claims.sub, 403, 'No puede consultar otro cliente');
  return view(customer, claims.role);
});

app.listen(ports.customers).then(() => bus.start());
