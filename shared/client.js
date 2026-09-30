'use strict';
// Cliente HTTP para llamadas síncronas entre servicios (consultas por API, nunca por copia de datos).
const { HttpError } = require('./http');

async function call(baseUrl, method, path, { body, token, headers } = {}) {
  let res;
  try {
    res = await fetch(baseUrl + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new HttpError(503, `Servicio no disponible (${baseUrl})`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new HttpError(res.status >= 500 ? 502 : res.status, data?.error || `Error ${res.status} en ${path}`);
  return data;
}

module.exports = { call };
