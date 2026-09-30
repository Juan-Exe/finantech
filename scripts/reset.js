'use strict';
// Borra los datos de todos los servicios para empezar una demostración desde cero.
const fs = require('node:fs');
const { DATA_DIR } = require('../shared/config');

fs.rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`Datos eliminados: ${DATA_DIR}`);
