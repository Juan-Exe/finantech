'use strict';
// "Base de datos por servicio": cada microservicio persiste únicamente sus datos en su propio archivo JSON.
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./config');

function createStore(name, defaults) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, `${name}.json`);

  let data;
  try {
    data = { ...structuredClone(defaults), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    data = structuredClone(defaults);
  }

  let timer = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const tmp = `${file}.tmp`;
    const payload = JSON.stringify(data, null, 2);
    // En Windows, un antivirus o el indexador pueden tener el archivo abierto justo
    // en este instante y hacer fallar el renombrado con EPERM/EBUSY. Se reintenta
    // unas pocas veces y, si aun así falla, se escribe directamente: perder un
    // guardado no debe tumbar el servicio.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.writeFileSync(tmp, payload);
        fs.renameSync(tmp, file);
        return;
      } catch (err) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code) || attempt === 4) {
          try {
            fs.writeFileSync(file, payload);
            return;
          } catch {
            console.error(`[store:${name}] no se pudo guardar: ${err.code || err.message}`);
            return;
          }
        }
        // Espera activa muy breve antes de reintentar (flush es síncrono).
        const until = Date.now() + 15 * (attempt + 1);
        while (Date.now() < until) { /* reintento */ }
      }
    }
  };
  process.on('exit', () => {
    if (timer) flush();
  });

  return {
    data,
    save() {
      if (!timer) timer = setTimeout(flush, 50);
    },
    flush,
  };
}

module.exports = { createStore };
