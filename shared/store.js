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
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
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
