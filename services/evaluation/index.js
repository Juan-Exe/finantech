'use strict';
// Microservicio de Evaluación y decisión (motor de reglas + scoring).
// Dueño de: reglas de negocio, modelo de scoring y políticas de riesgo, con trazabilidad para auditoría.
// No desembolsa ni registra contablemente.
const crypto = require('node:crypto');
const { createApp, assert } = require('../../shared/http');
const { authenticate, serviceToken } = require('../../shared/auth');
const { createStore } = require('../../shared/store');
const { createBusClient } = require('../../shared/bus');
const { call } = require('../../shared/client');
const { ports, urls, STAFF_ROLES } = require('../../shared/config');
const { sleep, now } = require('../../shared/util');

const app = createApp('evaluation');
const store = createStore('evaluation', { evaluations: {} });
const bus = createBusClient({ service: 'evaluation', app, port: ports.evaluation });

const POLICY = {
  version: 'politica-riesgo-v1.0',
  minBureauScore: 500, // por debajo: rechazo automático
  autoApproveScore: 680, // desde aquí: aprobación automática si cumple lo demás
  maxDtiAuto: 0.4, // endeudamiento máximo para aprobación automática
  maxDti: 0.6, // endeudamiento por encima del cual se rechaza
  maxAutoAmount: 20_000_000, // montos superiores van a revisión humana
};

// Central de riesgo simulada (determinística por documento, para demostraciones repetibles):
//   documento termina en 0 → reporte negativo; termina en 5 → historial insuficiente; resto → buen historial.
function bureauLookup(documentNumber) {
  const doc = String(documentNumber);
  if (doc.endsWith('0')) return { score: 450, negativeReports: 2, history: 'Reporte negativo vigente', source: 'Central de riesgo (simulada)' };
  if (doc.endsWith('5')) return { score: 610, negativeReports: 0, history: 'Historial crediticio insuficiente', source: 'Central de riesgo (simulada)' };
  const n = parseInt(crypto.createHash('sha256').update(doc).digest('hex').slice(0, 8), 16);
  return { score: 700 + (n % 150), negativeReports: 0, history: 'Buen comportamiento de pago', source: 'Central de riesgo (simulada)' };
}

function evaluate(request, customer) {
  const bureau = bureauLookup(customer.documentNumber);
  const dti = (request.monthlyExpenses + request.installment) / request.monthlyIncome;
  const rules = [];
  let score = bureau.score;

  if (dti <= 0.3) {
    score += 30;
    rules.push({ rule: 'Endeudamiento bajo (≤30%)', effect: '+30' });
  } else if (dti > 0.5) {
    score -= 60;
    rules.push({ rule: 'Endeudamiento alto (>50%)', effect: '-60' });
  }
  if (customer.kyc?.status === 'verificado') {
    score += 10;
    rules.push({ rule: 'Identidad verificada (KYC + biometría)', effect: '+10' });
  }
  score = Math.max(300, Math.min(900, score));

  const reasons = [];
  let decision;
  if (bureau.score < POLICY.minBureauScore) {
    decision = 'rechazado';
    reasons.push(`${bureau.history} en la central de riesgo`);
  } else if (dti > POLICY.maxDti) {
    decision = 'rechazado';
    reasons.push(`Capacidad de pago insuficiente: endeudamiento del ${(dti * 100).toFixed(1)}% (máximo ${POLICY.maxDti * 100}%)`);
  } else if (score >= POLICY.autoApproveScore && dti <= POLICY.maxDtiAuto && request.amount <= POLICY.maxAutoAmount) {
    decision = 'aprobado';
    reasons.push('Cumple la política de aprobación automática');
  } else {
    decision = 'revision_manual';
    if (score < POLICY.autoApproveScore) reasons.push(`Puntaje ${score} inferior a ${POLICY.autoApproveScore} (${bureau.history.toLowerCase()})`);
    if (dti > POLICY.maxDtiAuto) reasons.push(`Endeudamiento del ${(dti * 100).toFixed(1)}% supera el ${POLICY.maxDtiAuto * 100}% automático`);
    if (request.amount > POLICY.maxAutoAmount) reasons.push(`Monto superior a $${POLICY.maxAutoAmount.toLocaleString('es-CO')} requiere revisión humana`);
  }

  return {
    creditId: request.creditId,
    customerId: request.customerId,
    decision,
    score,
    dti: Number(dti.toFixed(4)),
    bureau,
    rules,
    reasons,
    policyVersion: POLICY.version,
    evaluatedAt: now(),
  };
}

bus.on('credit.requested', async (event) => {
  const request = event.payload;
  if (store.data.evaluations[request.creditId]) return;
  await sleep(1200); // tiempo de consulta a centrales de riesgo (simulado)
  const customer = await call(urls.customers, 'GET', `/customers/${request.customerId}`, { token: serviceToken('evaluation') });
  const result = evaluate(request, customer);
  store.data.evaluations[request.creditId] = result;
  store.save();
  console.log(`[evaluation] ${request.creditId.slice(0, 8)} → ${result.decision} (puntaje ${result.score})`);
  bus.publish('evaluation.completed', result);
});

app.get('/evaluations/policy', (req) => {
  authenticate(req, STAFF_ROLES);
  return POLICY;
});

app.get('/evaluations/:creditId', (req) => {
  authenticate(req, [...STAFF_ROLES, 'servicio']);
  const result = store.data.evaluations[req.params.creditId];
  assert(result, 404, 'No existe evaluación para este crédito');
  return result;
});

app.listen(ports.evaluation).then(() => bus.start());
