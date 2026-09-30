'use strict';
// Confianza cero: cada microservicio valida el token por sí mismo, aunque la llamada venga del API Gateway.
const { sign, verify } = require('./jwt');
const { JWT_SECRET } = require('./config');
const { HttpError } = require('./http');

function bearer(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function authenticate(req, roles) {
  const claims = verify(bearer(req), JWT_SECRET);
  if (!claims || claims.typ !== 'access') throw new HttpError(401, 'Token inválido o expirado');
  if (roles && !roles.includes(claims.role)) throw new HttpError(403, 'No tiene permisos para esta operación');
  req.user = claims;
  return claims;
}

// Identidad de servicio a servicio (credencial de máquina, rol "servicio").
const cache = new Map();
function serviceToken(service) {
  const cached = cache.get(service);
  if (cached && cached.exp > Date.now() / 1000 + 60) return cached.token;
  const ttl = 600;
  const token = sign({ sub: `svc:${service}`, role: 'servicio', typ: 'access' }, JWT_SECRET, ttl);
  cache.set(service, { token, exp: Date.now() / 1000 + ttl });
  return token;
}

module.exports = { authenticate, serviceToken, bearer };
