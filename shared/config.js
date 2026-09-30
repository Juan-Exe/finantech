'use strict';
// Configuración central: puertos de cada componente, secreto de firma y carpeta de datos.
// PORT_OFFSET permite levantar una segunda instancia (por ejemplo, las pruebas e2e) sin choques.
const path = require('node:path');

const offset = Number(process.env.PORT_OFFSET || 0);

const basePorts = {
  gateway: 8080,
  bus: 4100,
  identity: 4001,
  customers: 4002,
  credits: 4003,
  evaluation: 4004,
  disbursement: 4005,
  accounting: 4006,
  notifications: 4007,
  analytics: 4008,
};

const ports = Object.fromEntries(
  Object.entries(basePorts).map(([name, port]) => [name, port + offset]),
);
if (process.env.PORT) ports.gateway = Number(process.env.PORT);

const urls = Object.fromEntries(
  Object.entries(ports).map(([name, port]) => [name, `http://127.0.0.1:${port}`]),
);

module.exports = {
  ports,
  urls,
  JWT_SECRET: process.env.JWT_SECRET || 'finantech-dev-secret-cambiar-en-produccion',
  DATA_DIR: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  // En modo demo los códigos OTP se devuelven en la respuesta (en producción irían por SMS/correo).
  DEMO_MODE: process.env.DEMO_MODE !== 'false',
  STAFF_ROLES: ['analista', 'admin'],
};
