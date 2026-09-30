'use strict';
// Capa 1 — Canales. La app web y la app móvil son el mismo cliente sobre los mismos servicios del API Gateway:
// aquí no hay lógica de negocio, solo presentación y captura de datos.

// ---------------------------------------------------------------- utilidades
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const main = $('#main');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(Number(n) || 0);
const pct = (n, d = 1) => `${(Number(n) * 100).toFixed(d)}%`;
const dateTime = (s) => (s ? new Date(s).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const timeOnly = (s) => (s ? new Date(s).toLocaleTimeString('es-CO') : '—');
const dateOnly = (s) => (s ? new Date(`${s}T12:00:00`).toLocaleDateString('es-CO', { dateStyle: 'medium' }) : '—');
const formData = (form) => Object.fromEntries(new FormData(form).entries());
const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

const storage = {
  get(k, area = localStorage) {
    try {
      return area.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v, area = localStorage) {
    try {
      if (v === null) area.removeItem(k);
      else area.setItem(k, v);
    } catch {
      /* almacenamiento no disponible */
    }
  },
};

function toast(message, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// ---------------------------------------------------------------- estado y API
const state = {
  token: storage.get('ft_token', sessionStorage),
  user: JSON.parse(storage.get('ft_user', sessionStorage) || 'null'),
  // El canal se detecta por el tamaño de pantalla: en el celular la app se usa como app móvil.
  channel: window.matchMedia('(max-width: 700px)').matches ? 'movil' : 'web',
  meta: null,
};

let deviceId = storage.get('ft_device');
if (!deviceId) {
  deviceId = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);
  storage.set('ft_device', deviceId);
}

async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Channel': state.channel === 'movil' ? 'app-movil' : 'portal-web',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token && !path.startsWith('/auth/step-up')) {
    setSession(null);
    toast('Su sesión expiró. Ingrese de nuevo.', 'error');
    location.hash = '#/login';
  }
  if (!res.ok) {
    const err = new Error(data.error || `Error ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function setSession(session) {
  state.token = session?.token || null;
  state.user = session?.user || null;
  storage.set('ft_token', state.token, sessionStorage);
  storage.set('ft_user', state.user ? JSON.stringify(state.user) : null, sessionStorage);
}

async function meta() {
  if (!state.meta) state.meta = await api('GET', '/products');
  return state.meta;
}

const STATUS = {
  radicada: { label: 'Radicada', cls: 'info' },
  en_evaluacion: { label: 'En evaluación', cls: 'info' },
  revision_manual: { label: 'Revisión manual', cls: 'warn' },
  aprobada: { label: 'Aprobada', cls: 'ok' },
  rechazada: { label: 'Rechazada', cls: 'danger' },
  formalizada: { label: 'Desembolso en proceso', cls: 'info' },
  desembolsada: { label: 'Vigente', cls: 'accent' },
  pagada: { label: 'Pagada', cls: 'ok' },
};
const chip = (status) => `<span class="chip ${STATUS[status]?.cls || ''}">${esc(STATUS[status]?.label || status)}</span>`;

// ---------------------------------------------------------------- navegación
let poller = null;
// Cada navegación incrementa el contador; una vista que termina de cargar tarde no pinta sobre la actual.
let renderSeq = 0;
const stale = (seq) => seq !== renderSeq;
function poll(fn, ms) {
  clearInterval(poller);
  poller = setInterval(() => {
    if (!document.hidden) fn().catch(() => {});
  }, ms);
}

const NAV = {
  anon: [['#/login', 'Ingresar'], ['#/registro', 'Crear cuenta']],
  cliente: [['#/inicio', 'Mis créditos'], ['#/solicitar', 'Solicitar'], ['#/perfil', 'Mi perfil']],
  analista: [['#/revision', 'Revisión manual'], ['#/creditos', 'Créditos'], ['#/clientes', 'Clientes'], ['#/tablero', 'Tablero'], ['#/contabilidad', 'Contabilidad']],
  admin: [['#/tablero', 'Tablero'], ['#/creditos', 'Créditos'], ['#/clientes', 'Clientes'], ['#/contabilidad', 'Contabilidad'], ['#/eventos', 'Bus de eventos'], ['#/auditoria', 'Auditoría']],
};
const HOME = { cliente: '#/inicio', analista: '#/revision', admin: '#/tablero' };

function renderNav(current) {
  const role = state.user?.role || 'anon';
  const links = NAV[role]
    .map(([href, label]) => `<a href="${href}" class="${href === `#/${current}` ? 'active' : ''}">${label}</a>`)
    .join('');
  const user = state.user
    ? `<span class="spacer"></span><span class="user-pill">${esc(state.user.email)} · ${esc(role)}</span><a href="#/salir">Salir</a>`
    : '';
  $('#nav').innerHTML = links + user;
}

const ROUTES = {
  '': { view: viewLogin },
  login: { view: viewLogin },
  registro: { view: viewRegister },
  vinculacion: { view: viewOnboarding, roles: ['cliente'] },
  inicio: { view: viewClientHome, roles: ['cliente'] },
  solicitar: { view: viewApply, roles: ['cliente'] },
  credito: { view: viewCredit, roles: ['cliente', 'analista', 'admin'] },
  perfil: { view: viewProfile, roles: ['cliente'] },
  revision: { view: viewReview, roles: ['analista', 'admin'] },
  creditos: { view: viewAllCredits, roles: ['analista', 'admin'] },
  clientes: { view: viewCustomers, roles: ['analista', 'admin'] },
  tablero: { view: viewDashboard, roles: ['analista', 'admin'] },
  contabilidad: { view: viewAccounting, roles: ['analista', 'admin'] },
  eventos: { view: viewEvents, roles: ['admin'] },
  auditoria: { view: viewAudit, roles: ['admin'] },
};

async function render() {
  clearInterval(poller);
  const [name, ...params] = location.hash.replace(/^#\/?/, '').split('/');
  if (name === 'salir') {
    setSession(null);
    location.hash = '#/login';
    return;
  }
  const route = ROUTES[name];
  if (!route) {
    location.hash = '#/';
    return;
  }
  if (route.roles) {
    if (!state.user) {
      location.hash = '#/login';
      return;
    }
    if (!route.roles.includes(state.user.role)) {
      location.hash = HOME[state.user.role];
      return;
    }
  }
  const seq = ++renderSeq;
  renderNav(name);
  main.innerHTML = '<div class="loading"><span class="spinner"></span> Cargando…</div>';
  window.scrollTo(0, 0);
  try {
    await route.view(...params);
  } catch (err) {
    if (!stale(seq)) main.innerHTML = `<div class="alert danger">${esc(err.message)}</div>`;
  }
}

// ---------------------------------------------------------------- autenticación
function otpForm(challenge, { title, text, submitLabel }) {
  return `
    <div class="card" id="otp-card" style="max-width:440px;margin:0 auto">
      <h2>${esc(title)}</h2>
      <p class="muted">${esc(text)}</p>
      ${challenge.demoCode ? `<div class="alert info">📱 <b>Modo demostración:</b> código enviado por ${esc(challenge.channel)}: <b class="mono">${esc(challenge.demoCode)}</b></div>` : ''}
      <form id="otp-form" autocomplete="off" style="margin-top:14px">
        <div class="field"><input class="otp-input" name="code" inputmode="numeric" maxlength="6" required autofocus placeholder="••••••"></div>
        <button class="btn block">${esc(submitLabel)}</button>
      </form>
    </div>`;
}

async function afterLogin(session) {
  setSession(session);
  toast(`Bienvenido. ${session.mfa === 'dispositivo reconocido' ? 'Dispositivo reconocido: no se pidió segundo factor.' : 'Segundo factor verificado.'}`, 'ok');
  if (session.user.role !== 'cliente') {
    location.hash = HOME[session.user.role];
    return;
  }
  try {
    await api('GET', '/customers/me');
    location.hash = '#/inicio';
  } catch {
    location.hash = '#/vinculacion';
  }
}

async function login(email, password, container) {
  const result = await api('POST', '/auth/login', { email, password, deviceId });
  if (result.status === 'ok') return afterLogin(result);
  container.innerHTML = otpForm(result, {
    title: 'Verificación en dos pasos',
    text: 'Este dispositivo no está registrado. Ingrese el código de 6 dígitos que le enviamos.',
    submitLabel: 'Verificar e ingresar',
  });
  $('#otp-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const session = await api('POST', '/auth/mfa', { challengeId: result.challengeId, code: formData(e.target).code });
      await afterLogin(session);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

const QUICK_ACCESS = [
  { email: 'maria.gomez@correo.co', password: 'Cliente2026!', icon: '👤', title: 'Cliente', text: 'María Gómez · crédito vigente' },
  { email: 'analista@finantech.co', password: 'Analista2026!', icon: '🧾', title: 'Analista de crédito', text: 'Revisión manual de solicitudes' },
  { email: 'admin@finantech.co', password: 'Admin2026!', icon: '📊', title: 'Gerencia', text: 'Tablero, contabilidad y auditoría' },
];

function viewLogin() {
  if (state.user) {
    location.hash = HOME[state.user.role];
    return;
  }
  main.innerHTML = `
    <div id="auth-area" class="login-layout">
      <div class="card login-card">
        <div class="login-brand"><span class="brand-mark">F</span><div><h1>FinanTech</h1><p class="muted">Banca digital · Crédito en línea</p></div></div>
        <form id="login-form">
          <div class="field"><label>Correo electrónico</label><input name="email" type="email" required autocomplete="username" placeholder="usuario@correo.co"></div>
          <div class="field"><label>Contraseña</label><input name="password" type="password" required autocomplete="current-password"></div>
          <button class="btn block">Ingresar</button>
        </form>
        <p style="margin-top:14px;text-align:center" class="muted">¿Cliente nuevo? <a href="#/registro">Abra su cuenta 100% digital</a></p>
      </div>
      <div class="card">
        <h3>Acceso rápido de demostración</h3>
        <p class="muted">Entre con un usuario de prueba. La primera vez desde este navegador se pedirá un código OTP, que aquí se muestra en pantalla.</p>
        <div class="quick-list">
          ${QUICK_ACCESS.map((q, i) => `<button type="button" class="quick" data-i="${i}"><span class="quick-icon">${q.icon}</span><span><b>${esc(q.title)}</b><small>${esc(q.text)}</small><small class="mono">${esc(q.email)}</small></span></button>`).join('')}
        </div>
      </div>
    </div>`;
  const submit = async (email, password) => {
    try {
      await login(email, password, $('#auth-area'));
    } catch (err) {
      toast(err.status === 401 && email === QUICK_ACCESS[0].email ? 'El cliente demo no existe. Ejecute "npm run reset" y luego "npm start" para cargar los datos de ejemplo.' : err.message, 'error');
    }
  };
  $('#login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const { email, password } = formData(e.target);
    submit(email, password);
  });
  $$('.quick').forEach((btn) =>
    btn.addEventListener('click', () => {
      const q = QUICK_ACCESS[btn.dataset.i];
      submit(q.email, q.password);
    }),
  );
}

function viewRegister() {
  main.innerHTML = `
    <div id="auth-area">
      <div class="card" style="max-width:460px;margin:0 auto">
        <h2>Crear cuenta</h2>
        <p class="muted">Paso 1 de 2 — credenciales de acceso (servicio de Identidad).</p>
        <form id="reg-form">
          <div class="field"><label>Correo electrónico</label><input name="email" type="email" required autocomplete="username"></div>
          <div class="field"><label>Contraseña</label><input name="password" type="password" required minlength="8" autocomplete="new-password"><small class="muted">Mínimo 8 caracteres, con letras y números.</small></div>
          <div class="field"><label>Confirmar contraseña</label><input name="confirm" type="password" required autocomplete="new-password"></div>
          <button class="btn block">Crear cuenta</button>
        </form>
      </div>
    </div>`;
  $('#reg-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { email, password, confirm } = formData(e.target);
    if (password !== confirm) return toast('Las contraseñas no coinciden', 'error');
    try {
      await api('POST', '/auth/register', { email, password });
      toast('Cuenta creada', 'ok');
      await login(email, password, $('#auth-area'));
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

// ---------------------------------------------------------------- vinculación (onboarding)
function viewOnboarding() {
  main.innerHTML = `
    <div class="page-head"><div><h1>Vinculación digital</h1><p>Paso 2 de 2 — solo te pediremos estos datos una vez.</p></div></div>
    <form id="onb-form" class="grid-2">
      <div class="card">
        <h3>Datos personales</h3>
        <div class="grid-2">
          <div class="field"><label>Tipo de documento</label><select name="documentType"><option value="CC">Cédula de ciudadanía</option><option value="CE">Cédula de extranjería</option><option value="PA">Pasaporte</option></select></div>
          <div class="field"><label>Número de documento</label><input name="documentNumber" required inputmode="numeric" pattern="[0-9]{5,12}"></div>
          <div class="field"><label>Nombres</label><input name="firstName" required></div>
          <div class="field"><label>Apellidos</label><input name="lastName" required></div>
          <div class="field"><label>Fecha de nacimiento</label><input name="birthDate" type="date" required></div>
          <div class="field"><label>Celular</label><input name="phone" required inputmode="tel" placeholder="3001234567"></div>
          <div class="field"><label>Ciudad</label><input name="city" required value="Montería"></div>
          <div class="field"><label>Dirección</label><input name="address" required></div>
        </div>
        <div class="demo-box" style="margin-top:6px">
          <b>Datos de prueba (central de riesgo simulada)</b><br>
          Documento terminado en <code>0</code> → reporte negativo (rechazo) · en <code>5</code> → historial insuficiente (revisión manual) · inicia en <code>999</code> → coincidencia SARLAFT · cualquier otro → buen historial.
        </div>
      </div>
      <div class="stack">
        <div class="card">
          <h3>Validación biométrica</h3>
          <p class="muted">Prueba de vida para confirmar que eres tú (simulada en el prototipo).</p>
          <div class="liveness">
            <div class="face" id="face">🙂</div>
            <div style="flex:1"><div id="live-text">Ubica tu rostro frente a la cámara.</div>
            <button type="button" class="btn sm accent" id="live-btn" style="margin-top:8px">Iniciar prueba de vida</button></div>
          </div>
        </div>
        <div class="card">
          <h3>Autorizaciones</h3>
          <label class="check"><input type="checkbox" name="dataConsent" required> Autorizo a FinanTech el tratamiento de mis datos personales conforme a la Ley 1581 de 2012 y la consulta en centrales de riesgo.</label>
          <label class="check" style="margin-top:8px"><input type="checkbox" required> Declaro que mis recursos no provienen de actividades ilícitas (SARLAFT).</label>
          <button class="btn block" style="margin-top:16px">Completar vinculación</button>
        </div>
      </div>
    </form>`;
  let liveness = false;
  $('#live-btn').addEventListener('click', () => {
    const face = $('#face');
    face.className = 'face scanning';
    $('#live-text').textContent = 'Parpadea y gira levemente la cabeza…';
    $('#live-btn').disabled = true;
    setTimeout(() => {
      face.className = 'face ok';
      face.textContent = '✔';
      $('#live-text').innerHTML = '<b>Prueba de vida superada.</b> Rostro coincide con el documento.';
      liveness = true;
    }, 1800);
  });
  $('#onb-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!liveness) return toast('Complete la prueba de vida', 'error');
    const body = formData(e.target);
    try {
      const customer = await api('POST', '/customers', { ...body, dataConsent: true, livenessVerified: true });
      if (customer.kyc.status !== 'verificado') {
        main.innerHTML = `<div class="card" style="max-width:560px;margin:0 auto"><h2>Vinculación no aprobada</h2><div class="alert danger">No es posible continuar: su documento presenta coincidencias en listas restrictivas (SARLAFT).</div></div>`;
        return;
      }
      toast('Vinculación completada', 'ok');
      location.hash = '#/inicio';
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

// ---------------------------------------------------------------- cliente
function notificationsHtml(list) {
  if (!list.length) return '<div class="empty">Sin notificaciones</div>';
  return list
    .slice(0, 8)
    .map(
      (n) => `<div class="notif ${esc(n.level)} ${n.read ? '' : 'unread'}"><div class="bar"></div><div>
        <b>${esc(n.title)}</b><div>${esc(n.body)}</div>
        <div class="chan">${dateTime(n.createdAt)} · ${n.channels.map((c) => `${esc(c.type)} ${esc(c.to)}`).join(' · ')}</div></div></div>`,
    )
    .join('');
}

async function viewClientHome() {
  const seq = renderSeq;
  let customer;
  try {
    customer = await api('GET', '/customers/me');
  } catch {
    if (!stale(seq)) location.hash = '#/vinculacion';
    return;
  }
  if (stale(seq)) return;
  const load = async () => {
    const [credits, notifications] = await Promise.all([api('GET', '/credits'), api('GET', '/notifications/me')]);
    const active = credits.find((c) => c.status === 'desembolsada');
    const inProgress = credits.some((c) => ['en_evaluacion', 'revision_manual', 'aprobada', 'formalizada'].includes(c.status));
    $('#client-summary').innerHTML = active
      ? `<dl class="kv"><dt>Crédito vigente</dt><dd>${esc(active.number)}</dd><dt>Saldo de capital</dt><dd>${money(active.balance)}</dd>
         <dt>Próxima cuota</dt><dd>${money(active.schedule.find((r) => !r.paidAt)?.payment)}</dd><dt>Cuotas pagadas</dt><dd>${active.paidInstallments} / ${active.termMonths}</dd></dl>
         <a class="btn sm" style="margin-top:12px" href="#/credito/${active.id}">Ver y pagar</a>`
      : `<p class="muted">No tienes créditos vigentes.</p>${inProgress ? '' : '<a class="btn accent" href="#/solicitar">Solicitar crédito</a>'}`;
    $('#credit-list').innerHTML = credits.length
      ? `<div class="table-wrap"><table><thead><tr><th>Número</th><th>Producto</th><th class="num">Monto</th><th>Estado</th><th>Fecha</th></tr></thead><tbody>
        ${credits.map((c) => `<tr class="clickable" data-href="#/credito/${c.id}"><td class="mono">${esc(c.number)}</td><td>${esc(c.productName)}</td><td class="num">${money(c.amount)}</td><td>${chip(c.status)}</td><td>${dateTime(c.createdAt)}</td></tr>`).join('')}
        </tbody></table></div>`
      : '<div class="empty">Aún no has solicitado créditos.</div>';
    $$('#credit-list tr[data-href]').forEach((tr) => tr.addEventListener('click', () => (location.hash = tr.dataset.href)));
    $('#notifs').innerHTML = notificationsHtml(notifications);
  };
  main.innerHTML = `
    <div class="page-head"><div><h1>Hola, ${esc(customer.firstName)} 👋</h1><p>Cliente verificado · ${esc(customer.city)}</p></div>
      <a class="btn accent" href="#/solicitar">+ Nueva solicitud</a></div>
    <div class="grid-3">
      <div class="card"><h3>Resumen</h3><div id="client-summary"></div></div>
      <div class="card" style="grid-column: span 2"><div class="card-title"><h3>Notificaciones</h3><button class="btn sm ghost" id="mark-read">Marcar como leídas</button></div><div id="notifs"></div></div>
    </div>
    <div class="card"><h3>Mis solicitudes</h3><div id="credit-list"></div></div>`;
  $('#mark-read').addEventListener('click', async () => {
    await api('POST', '/notifications/me/read');
    load();
  });
  await load();
  poll(load, 4000);
}

async function viewApply() {
  const seq = renderSeq;
  const { products, banks, stepUpThreshold } = await meta();
  if (stale(seq)) return;
  main.innerHTML = `
    <div class="page-head"><div><h1>Solicitar crédito</h1><p>Tus datos personales ya están en tu perfil: solo necesitamos la información de esta solicitud.</p></div></div>
    <form id="apply-form" class="grid-2">
      <div class="card">
        <h3>Condiciones</h3>
        <div class="field"><label>Producto</label><select name="product">${products.map((p) => `<option value="${p.id}">${esc(p.name)} (${money(p.minAmount)} – ${money(p.maxAmount)})</option>`).join('')}</select></div>
        <div class="grid-2">
          <div class="field"><label>Monto</label><input name="amount" type="number" required value="5000000" step="100000"></div>
          <div class="field"><label>Plazo (meses)</label><input name="termMonths" type="number" required value="24"></div>
          <div class="field"><label>Ingresos mensuales</label><input name="monthlyIncome" type="number" required value="4500000" step="50000"></div>
          <div class="field"><label>Gastos y deudas mensuales</label><input name="monthlyExpenses" type="number" required value="1200000" step="50000"></div>
        </div>
        <div class="field"><label>Destino del crédito</label><select name="purpose"><option>Libre inversión</option><option>Estudios</option><option>Compra de vehículo</option><option>Mejoras de vivienda</option><option>Consolidación de deudas</option><option>Capital de trabajo</option></select></div>
      </div>
      <div class="stack">
        <div class="card">
          <h3>Cuenta para el desembolso</h3>
          <div class="field"><label>Banco</label><select name="bank">${banks.map((b) => `<option>${esc(b)}</option>`).join('')}</select></div>
          <div class="grid-2">
            <div class="field"><label>Tipo de cuenta</label><select name="accountType"><option value="ahorros">Ahorros</option><option value="corriente">Corriente</option></select></div>
            <div class="field"><label>Número de cuenta</label><input name="accountNumber" required inputmode="numeric" pattern="[0-9]{6,16}" value="4567891234"></div>
          </div>
          <small class="muted">Dato de prueba: una cuenta terminada en <code>000</code> simula un rechazo del banco.</small>
        </div>
        <div class="card">
          <h3>Resumen</h3>
          <div id="apply-summary" class="muted">Complete los datos…</div>
          <p class="muted" style="margin-top:10px"><small>Créditos superiores a ${money(stepUpThreshold)} requieren verificación reforzada (OTP) al firmar. Montos mayores a $20.000.000 pasan a revisión de un analista.</small></p>
          <button class="btn block accent" style="margin-top:8px">Radicar solicitud</button>
        </div>
      </div>
    </form>`;
  const form = $('#apply-form');
  const refresh = debounce(async () => {
    if (stale(seq)) return;
    const d = formData(form);
    try {
      const s = await api('GET', `/credits/simulate?product=${d.product}&amount=${d.amount}&term=${d.termMonths}`);
      const dti = (Number(d.monthlyExpenses) + s.installment) / Number(d.monthlyIncome);
      $('#apply-summary').innerHTML = `
        <dl class="kv"><dt>Cuota mensual</dt><dd>${money(s.installment)}</dd><dt>Tasa</dt><dd>${pct(s.monthlyRate, 2)} M.V. · ${pct(s.annualRate, 2)} E.A.</dd>
        <dt>Total a pagar</dt><dd>${money(s.totalPaid)}</dd><dt>Endeudamiento estimado</dt><dd>${Number.isFinite(dti) ? pct(dti) : '—'}</dd></dl>`;
    } catch (err) {
      $('#apply-summary').innerHTML = `<div class="alert warn">${esc(err.message)}</div>`;
    }
  }, 250);
  form.addEventListener('input', refresh);
  refresh();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    try {
      const credit = await api('POST', '/credits', { ...d, amount: Number(d.amount), termMonths: Number(d.termMonths), monthlyIncome: Number(d.monthlyIncome), monthlyExpenses: Number(d.monthlyExpenses) });
      toast('Solicitud radicada. Evaluando…', 'ok');
      location.hash = `#/credito/${credit.id}`;
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

const FLOW = [
  { key: 'radicada', label: 'Radicada' },
  { key: 'evaluacion', label: 'Evaluación' },
  { key: 'aprobacion', label: 'Aprobación' },
  { key: 'formalizacion', label: 'Firma' },
  { key: 'desembolso', label: 'Desembolso' },
];
const STAGE = { radicada: 1, en_evaluacion: 1, revision_manual: 2, aprobada: 3, rechazada: 2, formalizada: 4, desembolsada: 5, pagada: 5 };

function progressHtml(status) {
  const current = STAGE[status] ?? 0;
  return `<div class="progress">${FLOW.map((s, i) => {
    let cls = i < current ? 'done' : i === current ? 'current' : '';
    if (status === 'rechazada' && i === 2) cls = 'fail';
    return `<div class="p-step ${cls}"><div class="dot">${cls === 'done' ? '✓' : cls === 'fail' ? '✕' : i + 1}</div>${s.label}</div>`;
  }).join('')}</div>`;
}

async function stepUpFlow() {
  const challenge = await api('POST', '/auth/step-up', {});
  return new Promise((resolve, reject) => {
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;inset:0;background:rgba(15,27,45,.55);display:grid;place-items:center;z-index:50;padding:16px';
    holder.innerHTML = otpForm(challenge, { title: 'Verificación reforzada', text: 'Por el monto de este crédito, confirme la firma con un código de un solo uso.', submitLabel: 'Confirmar firma' });
    document.body.appendChild(holder);
    holder.addEventListener('click', (e) => {
      if (e.target === holder) {
        holder.remove();
        reject(new Error('Firma cancelada'));
      }
    });
    $('#otp-form', holder).addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('POST', '/auth/step-up/verify', { challengeId: challenge.challengeId, code: formData(e.target).code, purpose: 'firma_credito' });
        holder.remove();
        resolve(r.stepUpToken);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

async function viewCredit(id) {
  const isClient = state.user.role === 'cliente';
  const seq = renderSeq;
  let lastKey = '';
  const load = async () => {
    const c = await api('GET', `/credits/${id}`);
    if (stale(seq)) return;
    const key = `${c.status}|${c.paidInstallments}|${c.history.length}`;
    if (key === lastKey) return;
    lastKey = key;
    const next = c.schedule.find((r) => !r.paidAt);
    const compensated = c.status === 'aprobada' && c.history.at(-1)?.note?.startsWith('Compensación');
    let panel = '';
    if (c.status === 'en_evaluacion' || c.status === 'radicada') {
      panel = `<div class="alert info"><span class="spinner"></span> Estamos analizando tu solicitud. Esto toma solo unos segundos…</div>`;
    } else if (c.status === 'revision_manual') {
      panel = `<div class="alert warn">Tu solicitud está fuera de la política automática y fue asignada a un analista de crédito.</div>`;
    } else if (c.status === 'rechazada') {
      panel = `<div class="alert danger"><b>Solicitud no aprobada.</b> ${esc(c.history.at(-1)?.note || '')}</div>`;
    } else if (c.status === 'aprobada' && isClient) {
      panel = `
        ${compensated ? `<div class="alert danger"><b>El desembolso fue rechazado por el banco.</b> ${esc(c.history.at(-1).note.replace(/^Compensación: /, ''))}</div>` : '<div class="alert ok"><b>¡Crédito aprobado!</b> Revisa las condiciones y firma electrónicamente.</div>'}
        ${compensated ? `
          <form id="account-form" class="card" style="margin-top:12px">
            <h3>Actualizar cuenta destino</h3>
            <div class="grid-3">
              <div class="field"><label>Banco</label><select name="bank">${(await meta()).banks.map((b) => `<option ${b === c.disbursementAccount.bank ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select></div>
              <div class="field"><label>Tipo</label><select name="accountType"><option value="ahorros">Ahorros</option><option value="corriente">Corriente</option></select></div>
              <div class="field"><label>Número</label><input name="accountNumber" required pattern="[0-9]{6,16}"></div>
            </div>
            <button class="btn sm">Guardar cuenta</button>
          </form>` : ''}
        <div class="card" style="margin-top:12px">
          <h3>Contrato de crédito ${esc(c.number)}</h3>
          <dl class="kv"><dt>Monto</dt><dd>${money(c.amount)}</dd><dt>Plazo</dt><dd>${c.termMonths} meses</dd><dt>Tasa</dt><dd>${pct(c.monthlyRate, 2)} M.V. · ${pct(c.annualRate, 2)} E.A.</dd>
          <dt>Cuota fija</dt><dd>${money(c.installment)}</dd><dt>Cuenta destino</dt><dd>${esc(c.disbursementAccount.bank)} · ${esc(c.disbursementAccount.accountNumber)}</dd></dl>
          <form id="sign-form" style="margin-top:12px">
            <label class="check"><input type="checkbox" name="accept" required> Acepto las condiciones del contrato, el plan de pagos y autorizo el débito de las cuotas.</label>
            ${c.requiresStepUp ? '<p class="muted" style="margin-top:6px"><small>🔐 Este monto requiere verificación reforzada con OTP.</small></p>' : ''}
            <button class="btn accent" style="margin-top:10px">✍ Firmar electrónicamente</button>
          </form>
        </div>`;
    } else if (c.status === 'aprobada') {
      panel = `<div class="alert ok">Aprobado. Esperando la firma electrónica del cliente.</div>`;
    } else if (c.status === 'formalizada') {
      panel = `<div class="alert info"><span class="spinner"></span> Contrato firmado. Estamos transfiriendo el dinero a tu cuenta…</div>`;
    } else if (c.status === 'desembolsada' || c.status === 'pagada') {
      panel = `
        <div class="grid-3">
          <div class="card kpi"><div class="label">Saldo de capital</div><div class="value">${money(c.balance)}</div><div class="sub">de ${money(c.amount)}</div></div>
          <div class="card kpi"><div class="label">Cuotas pagadas</div><div class="value">${c.paidInstallments} / ${c.termMonths}</div><div class="sub">Ref. desembolso ${esc(c.disbursementReference || '')}</div></div>
          <div class="card kpi"><div class="label">Próxima cuota</div><div class="value">${next ? money(next.payment) : '—'}</div><div class="sub">${next ? `Vence ${dateOnly(next.dueDate)}` : 'Crédito pagado'}</div>
            ${isClient && next ? '<button class="btn sm accent" id="pay-btn" style="margin-top:8px">Pagar cuota (PSE)</button>' : ''}</div>
        </div>`;
    }

    const ev = c.evaluation;
    main.innerHTML = `
      <div class="page-head"><div><a href="${isClient ? '#/inicio' : '#/creditos'}">← Volver</a><h1 style="margin-top:6px">${esc(c.productName)} · ${money(c.amount)}</h1>
        <p>${esc(c.number)} · radicado ${dateTime(c.createdAt)} por ${c.channel === 'app-movil' ? 'app móvil' : 'portal web'}</p></div>${chip(c.status)}</div>
      <div class="card">${progressHtml(c.status)}</div>
      <div style="margin-top:16px">${panel}</div>
      <div class="grid-2" style="margin-top:16px">
        <div class="card"><h3>Trazabilidad del proceso</h3><ul class="timeline">
          ${c.history.slice().reverse().map((h) => `<li>${chip(h.status)} <span class="t-date">${dateTime(h.at)} · ${esc(h.by)}</span>${h.note ? `<div>${esc(h.note)}</div>` : ''}</li>`).join('')}
        </ul></div>
        <div class="card"><h3>Evaluación de riesgo</h3>
          ${ev ? `<dl class="kv"><dt>Decisión del motor</dt><dd>${esc(ev.decision.replace('_', ' '))}</dd><dt>Puntaje</dt><dd>${ev.score}</dd>
            <dt>Central de riesgo</dt><dd>${ev.bureau.score} · ${esc(ev.bureau.history)}</dd><dt>Endeudamiento</dt><dd>${pct(ev.dti)}</dd><dt>Política</dt><dd class="mono">${esc(ev.policyVersion)}</dd></dl>
            <ul style="margin:10px 0 0;padding-left:18px">${ev.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`
          : '<div class="empty">Pendiente</div>'}
          ${c.contract ? `<hr style="border:0;border-top:1px solid var(--line);margin:14px 0"><h3>Firma electrónica</h3><dl class="kv"><dt>Firmado</dt><dd>${dateTime(c.contract.signedAt)}</dd><dt>Método</dt><dd>${esc(c.contract.method)}</dd><dt>Huella SHA-256</dt><dd class="mono" title="${esc(c.contract.signatureHash)}">${esc(c.contract.signatureHash.slice(0, 20))}…</dd></dl>` : ''}
        </div>
      </div>
      ${c.schedule.length ? `<div class="card"><h3>Plan de amortización (sistema francés)</h3><div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Vence</th><th class="num">Cuota</th><th class="num">Capital</th><th class="num">Interés</th><th class="num">Saldo</th><th>Estado</th></tr></thead><tbody>
        ${c.schedule.map((r) => `<tr class="${r.paidAt ? 'paid' : ''}"><td>${r.number}</td><td>${dateOnly(r.dueDate)}</td><td class="num">${money(r.payment)}</td><td class="num">${money(r.principal)}</td><td class="num">${money(r.interest)}</td><td class="num">${money(r.balance)}</td><td>${r.paidAt ? '<span class="chip ok">Pagada</span>' : '<span class="chip">Pendiente</span>'}</td></tr>`).join('')}
        </tbody></table></div></div>` : ''}`;

    $('#sign-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const body = { acceptTerms: true };
        if (c.requiresStepUp) body.stepUpToken = await stepUpFlow();
        await api('POST', `/credits/${c.id}/sign`, body);
        toast('Contrato firmado', 'ok');
        load();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    $('#account-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('PATCH', `/credits/${c.id}/account`, formData(e.target));
        toast('Cuenta actualizada. Ya puede firmar de nuevo.', 'ok');
        lastKey = '';
        load();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    $('#pay-btn')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const p = await api('POST', '/payments', { creditId: c.id });
        toast(`Pago recibido: cuota ${p.installmentNumber} por ${money(p.amount)} (ref. ${p.reference})`, 'ok');
      } catch (err) {
        toast(err.message, 'error');
        e.target.disabled = false;
      }
    });
  };
  await load();
  poll(load, 1500);
}

async function viewProfile() {
  const seq = renderSeq;
  const c = await api('GET', '/customers/me');
  if (stale(seq)) return;
  main.innerHTML = `
    <div class="page-head"><div><h1>Mi perfil</h1><p>Tus datos personales y de contacto.</p></div></div>
    <div class="grid-2">
      <div class="card"><h3>Datos personales</h3>
        <dl class="kv"><dt>Nombre</dt><dd>${esc(c.firstName)} ${esc(c.lastName)}</dd><dt>Documento</dt><dd>${esc(c.documentType)} ${esc(c.documentNumber)}</dd>
        <dt>Correo</dt><dd>${esc(c.email)}</dd><dt>Nacimiento</dt><dd>${dateOnly(c.birthDate)}</dd><dt>Estado KYC</dt><dd>${c.kyc.status === 'verificado' ? '<span class="chip ok">Verificado</span>' : '<span class="chip danger">Rechazado</span>'}</dd>
        <dt>Prueba de vida</dt><dd>${c.kyc.livenessVerified ? 'Superada' : '—'}</dd><dt>SARLAFT</dt><dd>${esc(c.kyc.sarlaft.replace('_', ' '))}</dd><dt>Autorización de datos</dt><dd>${dateTime(c.consent.at)}</dd></dl>
      </div>
      <form class="card" id="profile-form"><h3>Datos de contacto</h3>
        <div class="field"><label>Celular</label><input name="phone" value="${esc(c.phone)}"></div>
        <div class="field"><label>Ciudad</label><input name="city" value="${esc(c.city)}"></div>
        <div class="field"><label>Dirección</label><input name="address" value="${esc(c.address)}"></div>
        <button class="btn">Guardar cambios</button>
      </form>
    </div>`;
  $('#profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PATCH', '/customers/me', formData(e.target));
      toast('Datos actualizados', 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

// ---------------------------------------------------------------- analista
async function viewReview() {
  const load = async () => {
    const pending = await api('GET', '/credits?status=revision_manual');
    const customers = await Promise.all(pending.map((c) => api('GET', `/customers/${c.customerId}`).catch(() => null)));
    $('#queue').innerHTML = pending.length
      ? pending
          .map((c, i) => {
            const cu = customers[i];
            const ev = c.evaluation;
            return `<div class="card">
          <div class="card-title"><h3>${esc(c.number)} · ${esc(c.productName)} · ${money(c.amount)}</h3>${chip(c.status)}</div>
          <div class="grid-3">
            <div><b>Cliente</b><dl class="kv"><dt>Nombre</dt><dd>${esc(cu ? `${cu.firstName} ${cu.lastName}` : '—')}</dd><dt>Documento</dt><dd class="mono">${esc(cu?.documentNumber)}</dd><dt>Contacto</dt><dd>${esc(cu?.phone)}</dd><dt>KYC</dt><dd>${esc(cu?.kyc.status)}</dd></dl></div>
            <div><b>Capacidad de pago</b><dl class="kv"><dt>Ingresos</dt><dd>${money(c.monthlyIncome)}</dd><dt>Gastos</dt><dd>${money(c.monthlyExpenses)}</dd><dt>Cuota</dt><dd>${money(c.installment)}</dd><dt>Endeudamiento</dt><dd>${pct(ev.dti)}</dd></dl></div>
            <div><b>Motor de evaluación</b><dl class="kv"><dt>Puntaje</dt><dd>${ev.score}</dd><dt>Central</dt><dd>${ev.bureau.score}</dd></dl>
              <ul style="margin:6px 0 0;padding-left:18px;font-size:.85rem">${ev.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>
          </div>
          <form class="review-form" data-id="${c.id}" style="margin-top:12px">
            <div class="field"><label>Concepto del analista</label><textarea name="note" rows="2" placeholder="Justificación de la decisión (obligatoria para rechazar)"></textarea></div>
            <div class="row"><button class="btn accent" value="aprobar">Aprobar</button><button class="btn danger" value="rechazar">Rechazar</button>
            <a class="btn ghost" href="#/credito/${c.id}">Ver detalle</a></div>
          </form></div>`;
          })
          .join('')
      : '<div class="card empty">🎉 No hay solicitudes pendientes de revisión manual.</div>';
    $$('.review-form').forEach((form) =>
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const decision = e.submitter.value;
        try {
          await api('POST', `/credits/${form.dataset.id}/review`, { decision, note: formData(form).note });
          toast(decision === 'aprobar' ? 'Crédito aprobado' : 'Crédito rechazado', 'ok');
          load();
        } catch (err) {
          toast(err.message, 'error');
        }
      }),
    );
  };
  main.innerHTML = `
    <div class="page-head"><div><h1>Revisión manual</h1><p>Casos que el motor derivó por estar fuera de la política automática. Los datos personales se muestran enmascarados (mínimo privilegio).</p></div></div>
    <div id="queue" class="stack"></div>`;
  await load();
}

async function viewAllCredits() {
  const load = async () => {
    const status = $('#status-filter').value;
    const credits = await api('GET', `/credits${status ? `?status=${status}` : ''}`);
    $('#all-credits').innerHTML = credits.length
      ? `<div class="table-wrap"><table><thead><tr><th>Número</th><th>Producto</th><th class="num">Monto</th><th>Plazo</th><th>Canal</th><th>Puntaje</th><th>Estado</th><th>Actualizado</th></tr></thead><tbody>
        ${credits.map((c) => `<tr class="clickable" data-href="#/credito/${c.id}"><td class="mono">${esc(c.number)}</td><td>${esc(c.productName)}</td><td class="num">${money(c.amount)}</td><td>${c.termMonths} m</td><td>${esc(c.channel)}</td><td>${c.evaluation?.score ?? '—'}</td><td>${chip(c.status)}</td><td>${dateTime(c.updatedAt)}</td></tr>`).join('')}
        </tbody></table></div>`
      : '<div class="empty">Sin créditos</div>';
    $$('#all-credits tr[data-href]').forEach((tr) => tr.addEventListener('click', () => (location.hash = tr.dataset.href)));
  };
  main.innerHTML = `
    <div class="page-head"><div><h1>Créditos</h1><p>Vista consolidada desde el servicio de Créditos.</p></div>
      <select id="status-filter" style="width:auto"><option value="">Todos los estados</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select></div>
    <div class="card" id="all-credits"></div>`;
  $('#status-filter').addEventListener('change', load);
  await load();
  poll(load, 4000);
}

async function viewCustomers() {
  const load = async () => {
    const q = $('#customer-q').value.trim();
    const [customers, credits] = await Promise.all([api('GET', `/customers${q ? `?q=${encodeURIComponent(q)}` : ''}`), api('GET', '/credits')]);
    const byCustomer = {};
    for (const c of credits) (byCustomer[c.customerId] ||= []).push(c);
    $('#customers').innerHTML = customers.length
      ? `<div class="table-wrap"><table><thead><tr><th>Cliente</th><th>Documento</th><th>Contacto</th><th>Ciudad</th><th>KYC</th><th>Créditos</th><th class="num">Saldo vigente</th><th>Vinculado</th></tr></thead><tbody>
        ${customers.map((cu) => {
          const list = byCustomer[cu.id] || [];
          const balance = list.filter((c) => c.status === 'desembolsada').reduce((s, c) => s + c.balance, 0);
          return `<tr><td><b>${esc(cu.firstName)} ${esc(cu.lastName)}</b><br><small class="muted">${esc(cu.email)}</small></td><td class="mono">${esc(cu.documentType)} ${esc(cu.documentNumber)}</td><td>${esc(cu.phone)}</td><td>${esc(cu.city)}</td>
            <td>${cu.kyc.status === 'verificado' ? '<span class="chip ok">Verificado</span>' : '<span class="chip danger">Rechazado</span>'}</td>
            <td>${list.map((c) => `<a href="#/credito/${c.id}" title="${esc(c.productName)} ${money(c.amount)}">${chip(c.status)}</a>`).join(' ') || '<small class="muted">—</small>'}</td>
            <td class="num">${balance ? money(balance) : '—'}</td><td>${dateTime(cu.createdAt)}</td></tr>`;
        }).join('')}
        </tbody></table></div>`
      : '<div class="empty">No hay clientes que coincidan</div>';
  };
  main.innerHTML = `
    <div class="page-head"><div><h1>Clientes</h1><p>Base única de clientes de FinanTech. ${state.user.role === 'analista' ? 'Como analista, ve los datos sensibles enmascarados.' : ''}</p></div>
      <input id="customer-q" type="search" placeholder="Buscar por nombre, documento o correo" style="max-width:320px"></div>
    <div class="card" id="customers"></div>`;
  $('#customer-q').addEventListener('input', debounce(load, 250));
  await load();
}

// ---------------------------------------------------------------- gerencia
async function viewDashboard() {
  const load = async () => {
    const [k, health] = await Promise.all([api('GET', '/analytics/kpis'), api('GET', '/health')]);
    const max = Math.max(1, ...k.funnel.map((f) => f.value));
    const seconds = k.avgRequestToDisbursementSeconds;
    $('#kpis').innerHTML = `
      <div class="card kpi"><div class="label">Clientes vinculados</div><div class="value">${k.customers.registered}</div><div class="sub">${k.customers.kycRejected} rechazados por SARLAFT</div></div>
      <div class="card kpi"><div class="label">Solicitudes</div><div class="value">${k.credits.requested}</div><div class="sub">${money(k.credits.amountRequested)} solicitados</div></div>
      <div class="card kpi"><div class="label">Decisión automática</div><div class="value">${pct(k.automaticDecisionRate, 0)}</div><div class="sub">Aprobación ${pct(k.approvalRate, 0)}</div></div>
      <div class="card kpi"><div class="label">Solicitud → desembolso</div><div class="value">${seconds === null ? '—' : seconds < 120 ? `${seconds.toFixed(1)} s` : `${(seconds / 60).toFixed(1)} min`}</div><div class="sub">Antes: días de conciliación manual</div></div>
      <div class="card kpi"><div class="label">Desembolsado</div><div class="value">${money(k.money.disbursed)}</div><div class="sub">${k.credits.disbursed} créditos · ${k.credits.disbursementFailures} rechazos ACH</div></div>
      <div class="card kpi"><div class="label">Cartera vigente</div><div class="value">${money(k.money.portfolio)}</div><div class="sub">Capital pendiente</div></div>
      <div class="card kpi"><div class="label">Recaudo</div><div class="value">${money(k.money.collected)}</div><div class="sub">Cuotas pagadas por PSE</div></div>
      <div class="card kpi"><div class="label">Ingresos por intereses</div><div class="value">${money(k.money.interestIncome)}</div><div class="sub">Cuenta PUC 4102</div></div>`;
    $('#funnel').innerHTML = k.funnel.map((f) => `<div class="funnel-row"><span>${esc(f.stage)}</span><div class="funnel-bar" style="width:${(f.value / max) * 100}%"></div><b>${f.value}</b></div>`).join('')
      + `<p class="muted" style="margin-top:10px"><small>Revisión manual: ${k.credits.sentToManualReview} · Aprobadas por analista: ${k.credits.approvedManual} · Rechazadas: ${k.credits.rejected} · Canales: ${Object.entries(k.byChannel).map(([c, n]) => `${esc(c)} ${n}`).join(', ') || '—'}</small></p>`;
    const names = { libre_inversion: 'Libre inversión', educativo: 'Educativo', vehiculo: 'Vehículo' };
    $('#by-product').innerHTML = k.byProduct.length
      ? `<table><thead><tr><th>Producto</th><th class="num">Solicitudes</th><th class="num">Monto</th></tr></thead><tbody>${k.byProduct.map((p) => `<tr><td>${esc(names[p.product] || p.product)}</td><td class="num">${p.requests}</td><td class="num">${money(p.amount)}</td></tr>`).join('')}</tbody></table>`
      : '<div class="empty">Sin datos</div>';
    $('#health').innerHTML = `<div class="row">${health.services.map((s) => `<span class="chip ${s.status === 'UP' ? 'ok' : 'danger'}"><span class="health ${s.status === 'UP' ? 'up' : 'down'}"></span>${esc(s.service)}${s.latencyMs !== null ? ` · ${s.latencyMs} ms` : ''}</span>`).join('')}</div>`;
    $('#recent').innerHTML = k.recent.map((e) => `<div class="event-line"><span class="chip info mono">${esc(e.topic)}</span><small>${esc(e.source)} · ${timeOnly(e.at)}</small></div>`).join('') || '<div class="empty">Sin eventos</div>';
  };
  main.innerHTML = `
    <div class="page-head"><div><h1>Tablero de gestión</h1><p>Bodega analítica alimentada en tiempo real por el bus de eventos (sin consultar bases transaccionales).</p></div><span class="chip accent">Actualización automática</span></div>
    <div class="grid-4" id="kpis"></div>
    <div class="grid-3" style="margin-top:16px">
      <div class="card" style="grid-column: span 2"><h3>Embudo de originación</h3><div id="funnel"></div></div>
      <div class="card"><h3>Últimos eventos</h3><div id="recent"></div></div>
    </div>
    <div class="grid-2" style="margin-top:16px">
      <div class="card"><h3>Solicitudes por producto</h3><div id="by-product" class="table-wrap"></div></div>
      <div class="card"><h3>Estado de los servicios</h3><div id="health"></div><p class="muted" style="margin-top:10px"><small>Observabilidad: el API Gateway consulta <code>/health</code> de cada microservicio.</small></p></div>
    </div>`;
  await load();
  poll(load, 3000);
}

async function viewAccounting() {
  const load = async () => {
    const [tb, entries] = await Promise.all([api('GET', '/accounting/trial-balance'), api('GET', '/accounting/entries?limit=40')]);
    $('#tb').innerHTML = `
      <div class="card-title"><h3>Balance de prueba</h3>${tb.balanced ? '<span class="chip ok">✓ Cuadrado — partida doble</span>' : '<span class="chip danger">Descuadrado</span>'}</div>
      <div class="table-wrap"><table><thead><tr><th>Cuenta</th><th>Nombre</th><th class="num">Débitos</th><th class="num">Créditos</th><th class="num">Saldo</th></tr></thead><tbody>
      ${tb.rows.map((r) => `<tr><td class="mono">${r.account}</td><td>${esc(r.name)}</td><td class="num">${money(r.debit)}</td><td class="num">${money(r.credit)}</td><td class="num"><b>${money(r.balance)}</b></td></tr>`).join('')}
      <tr><td></td><td><b>Totales</b></td><td class="num"><b>${money(tb.totalDebit)}</b></td><td class="num"><b>${money(tb.totalCredit)}</b></td><td></td></tr></tbody></table></div>`;
    $('#entries').innerHTML = entries.entries
      .map((e) => `<div style="padding:10px 0;border-bottom:1px solid var(--line)">
        <div class="row between"><b class="mono">${esc(e.number)}</b><small>${dateTime(e.date)} · origen: <code>${esc(e.sourceEvent)}</code></small></div>
        <div>${esc(e.description)}</div>
        <table style="margin-top:6px"><tbody>${e.lines.map((l) => `<tr><td class="mono">${l.account}</td><td>${esc(l.name)}</td><td class="num">${l.debit ? money(l.debit) : ''}</td><td class="num">${l.credit ? money(l.credit) : ''}</td></tr>`).join('')}</tbody></table></div>`)
      .join('');
  };
  main.innerHTML = `
    <div class="page-head"><div><h1>Contabilidad</h1><p>Asientos generados automáticamente al consumir eventos del bus: sin archivos planos ni cargas manuales.</p></div></div>
    <div class="card" id="tb"></div>
    <div class="card"><h3>Libro diario</h3><div id="entries"></div></div>`;
  await load();
  poll(load, 4000);
}

async function viewEvents() {
  const load = async () => {
    const [ev, subs] = await Promise.all([api('GET', `/bus/events?limit=120${$('#topic').value ? `&topic=${$('#topic').value}` : ''}`), api('GET', '/bus/subscriptions')]);
    $('#events').innerHTML = ev.events.length
      ? `<div class="table-wrap"><table><thead><tr><th>Hora</th><th>Evento</th><th>Publicado por</th><th>Entregas a suscriptores</th></tr></thead><tbody>
      ${ev.events.map((e) => `<tr><td class="mono">${timeOnly(e.occurredAt)}</td><td><span class="chip info mono">${esc(e.topic)}</span></td><td>${esc(e.source)}</td>
        <td>${Object.entries(e.deliveries).map(([s, d]) => `<span class="chip ${d.status === 'entregado' ? 'ok' : d.status === 'fallido' ? 'danger' : 'warn'}" title="${esc(d.lastError || '')}">${esc(s)}${d.attempts > 1 ? ` ×${d.attempts}` : ''}</span>`).join(' ') || '<small class="muted">sin suscriptores</small>'}</td></tr>`).join('')}
      </tbody></table></div>`
      : '<div class="empty">Aún no hay eventos</div>';
    $('#subs').innerHTML = subs.map((s) => `<div style="padding:6px 0;border-bottom:1px solid var(--line)"><b>${esc(s.service)}</b><div>${s.topics.map((t) => `<span class="chip mono">${esc(t)}</span>`).join(' ')}</div></div>`).join('');
  };
  main.innerHTML = `
    <div class="page-head"><div><h1>Bus de eventos</h1><p>Los servicios publican hechos de negocio; los suscriptores los consumen sin conocerse entre sí.</p></div>
      <select id="topic" style="width:auto"><option value="">Todos los eventos</option>${['customer.registered', 'credit.requested', 'evaluation.completed', 'credit.approved', 'credit.rejected', 'credit.manual_review', 'credit.formalized', 'disbursement.completed', 'disbursement.failed', 'payment.received', 'credit.paid_off'].map((t) => `<option>${t}</option>`).join('')}</select></div>
    <div class="grid-3"><div class="card" style="grid-column: span 2" id="events"></div><div class="card"><h3>Suscripciones</h3><div id="subs"></div></div></div>`;
  $('#topic').addEventListener('change', load);
  await load();
  poll(load, 2500);
}

async function viewAudit() {
  const load = async () => {
    const a = await api('GET', '/audit?limit=200');
    $('#integrity').innerHTML = a.integrity.valid
      ? `<span class="chip ok">✓ Cadena íntegra · ${a.total} registros</span>`
      : `<span class="chip danger">✕ Cadena alterada en el registro ${a.integrity.brokenAt}</span>`;
    $('#audit').innerHTML = `<div class="table-wrap"><table><thead><tr><th>#</th><th>Hora</th><th>Usuario</th><th>Rol</th><th>Canal</th><th>Operación</th><th>Estado</th><th class="num">ms</th><th>Hash</th></tr></thead><tbody>
      ${a.entries.map((e) => `<tr><td>${e.seq}</td><td class="mono">${timeOnly(e.at)}</td><td>${esc(e.user)}</td><td>${esc(e.role)}</td><td>${esc(e.channel)}</td><td class="mono">${esc(e.method)} ${esc(e.path)}</td>
        <td><span class="chip ${e.status < 300 ? 'ok' : e.status < 500 ? 'warn' : 'danger'}">${e.status}</span></td><td class="num">${e.ms}</td><td class="mono" title="${esc(e.hash)}">${esc(e.hash.slice(0, 10))}</td></tr>`).join('')}
      </tbody></table></div>`;
  };
  main.innerHTML = `
    <div class="page-head"><div><h1>Auditoría</h1><p>Toda llamada pasa por el API Gateway: quién accedió a qué, desde qué canal y cuándo. Cada registro incluye el hash del anterior.</p></div><div id="integrity"></div></div>
    <div class="card" id="audit"></div>`;
  await load();
  poll(load, 4000);
}

// ---------------------------------------------------------------- arranque
window.addEventListener('hashchange', render);
render();
