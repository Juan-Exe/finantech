'use strict';
// Microservicio de Identidad y Acceso (proveedor de identidad centralizado).
// Dueño de: credenciales, factores de autenticación, dispositivos confiables, roles y sesiones.
// No almacena datos personales del cliente (eso pertenece al servicio de Clientes).
const crypto = require('node:crypto');
const { createApp, reply, assert, required, HttpError } = require('../../shared/http');
const { authenticate } = require('../../shared/auth');
const { sign } = require('../../shared/jwt');
const { createStore } = require('../../shared/store');
const { createBusClient } = require('../../shared/bus');
const { ports, JWT_SECRET, DEMO_MODE } = require('../../shared/config');
const { now } = require('../../shared/util');

const app = createApp('identity');
const store = createStore('identity', { users: {}, challenges: {} });
const bus = createBusClient({ service: 'identity', app, port: ports.identity });

const MAX_FAILED = 5;
const LOCK_MINUTES = 5;
const OTP_TTL_MS = 5 * 60 * 1000;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

function checkPassword(user, password) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.passwordHash, 'hex'));
}

function createUser(email, password, role) {
  const { salt, hash } = hashPassword(password);
  const user = {
    id: crypto.randomUUID(),
    email,
    role,
    salt,
    passwordHash: hash,
    knownDevices: [],
    failedAttempts: 0,
    lockedUntil: null,
    createdAt: now(),
  };
  store.data.users[user.id] = user;
  store.save();
  return user;
}

const findByEmail = (email) => Object.values(store.data.users).find((u) => u.email === email);
const publicUser = (u) => ({ id: u.id, email: u.email, role: u.role, createdAt: u.createdAt });
const issueToken = (u) => sign({ sub: u.id, email: u.email, role: u.role, typ: 'access' }, JWT_SECRET, 3600);

function createChallenge(user, purpose, deviceId) {
  const challenge = {
    id: crypto.randomUUID(),
    userId: user.id,
    purpose,
    deviceId: deviceId || null,
    code: String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'),
    expiresAt: Date.now() + OTP_TTL_MS,
    attempts: 0,
  };
  store.data.challenges[challenge.id] = challenge;
  store.save();
  return {
    challengeId: challenge.id,
    channel: 'SMS y correo (simulado)',
    expiresInSeconds: OTP_TTL_MS / 1000,
    ...(DEMO_MODE ? { demoCode: challenge.code } : {}),
  };
}

function consumeChallenge(challengeId, code, purpose) {
  const c = store.data.challenges[challengeId];
  assert(c && c.purpose === purpose, 400, 'El desafío de verificación no existe');
  if (c.expiresAt < Date.now()) {
    delete store.data.challenges[challengeId];
    store.save();
    throw new HttpError(400, 'El código expiró. Solicite uno nuevo.');
  }
  if (String(code).trim() !== c.code) {
    c.attempts += 1;
    if (c.attempts >= 3) delete store.data.challenges[challengeId];
    store.save();
    throw new HttpError(401, 'Código de verificación incorrecto');
  }
  delete store.data.challenges[challengeId];
  store.save();
  return c;
}

// Usuarios internos de demostración.
if (!Object.values(store.data.users).some((u) => u.role === 'admin')) {
  createUser('admin@finantech.co', 'Admin2026!', 'admin');
  createUser('analista@finantech.co', 'Analista2026!', 'analista');
  console.log('[identity] usuarios internos de demostración creados');
}

app.post('/auth/register', (req) => {
  required(req.body, ['email', 'password']);
  const email = String(req.body.email).trim().toLowerCase();
  const { password } = req.body;
  assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 400, 'Correo electrónico inválido');
  assert(
    typeof password === 'string' && password.length >= 8 && /[A-Za-z]/.test(password) && /\d/.test(password),
    400,
    'La contraseña debe tener mínimo 8 caracteres e incluir letras y números',
  );
  assert(!findByEmail(email), 409, 'Ya existe una cuenta con este correo');
  const user = createUser(email, password, 'cliente');
  bus.publish('identity.user_registered', { userId: user.id, role: user.role });
  return reply(201, publicUser(user));
});

app.post('/auth/login', (req) => {
  required(req.body, ['email', 'password']);
  const user = findByEmail(String(req.body.email).trim().toLowerCase());
  if (!user) throw new HttpError(401, 'Credenciales inválidas');
  if (user.lockedUntil && user.lockedUntil > Date.now()) {
    const minutes = Math.ceil((user.lockedUntil - Date.now()) / 60000);
    throw new HttpError(423, `Cuenta bloqueada temporalmente por intentos fallidos. Intente en ${minutes} min.`);
  }
  if (!checkPassword(user, String(req.body.password))) {
    user.failedAttempts += 1;
    if (user.failedAttempts >= MAX_FAILED) {
      user.lockedUntil = Date.now() + LOCK_MINUTES * 60000;
      user.failedAttempts = 0;
      bus.publish('identity.account_locked', { userId: user.id, until: new Date(user.lockedUntil).toISOString() });
    }
    store.save();
    throw new HttpError(401, 'Credenciales inválidas');
  }
  user.failedAttempts = 0;
  store.save();

  // Seguridad adaptativa: desde un dispositivo reconocido no se exige segundo factor.
  const { deviceId } = req.body;
  if (deviceId && user.knownDevices.includes(deviceId)) {
    return { status: 'ok', token: issueToken(user), user: publicUser(user), mfa: 'dispositivo reconocido' };
  }
  return { status: 'mfa_required', ...createChallenge(user, 'login', deviceId) };
});

app.post('/auth/mfa', (req) => {
  required(req.body, ['challengeId', 'code']);
  const challenge = consumeChallenge(req.body.challengeId, req.body.code, 'login');
  const user = store.data.users[challenge.userId];
  if (challenge.deviceId && !user.knownDevices.includes(challenge.deviceId)) {
    user.knownDevices.push(challenge.deviceId);
    if (user.knownDevices.length > 5) user.knownDevices.shift();
    store.save();
  }
  return { status: 'ok', token: issueToken(user), user: publicUser(user), mfa: 'otp' };
});

// Autenticación reforzada (step-up) para operaciones de alto riesgo, p. ej. firmar un crédito de monto alto.
app.post('/auth/step-up', (req) => {
  const claims = authenticate(req);
  const user = store.data.users[claims.sub];
  assert(user, 404, 'Usuario no encontrado');
  return createChallenge(user, 'step-up', null);
});

app.post('/auth/step-up/verify', (req) => {
  const claims = authenticate(req);
  required(req.body, ['challengeId', 'code']);
  const challenge = consumeChallenge(req.body.challengeId, req.body.code, 'step-up');
  assert(challenge.userId === claims.sub, 403, 'El desafío no pertenece a este usuario');
  const stepUpToken = sign({ sub: claims.sub, typ: 'step-up', purpose: req.body.purpose || 'firma_credito' }, JWT_SECRET, 300);
  return { stepUpToken, expiresInSeconds: 300 };
});

app.get('/auth/me', (req) => {
  const claims = authenticate(req);
  const user = store.data.users[claims.sub];
  assert(user, 404, 'Usuario no encontrado');
  return publicUser(user);
});

app.get('/users', (req) => {
  authenticate(req, ['admin']);
  return Object.values(store.data.users).map(publicUser);
});

app.listen(ports.identity).then(() => bus.start());
