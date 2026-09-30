'use strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const now = () => new Date().toISOString();

const maskTail = (value, visible = 4) => {
  const s = String(value || '');
  return s.length <= visible ? s : `${'*'.repeat(Math.max(3, s.length - visible))}${s.slice(-visible)}`;
};

const maskEmail = (email) => {
  const [user, domain] = String(email || '').split('@');
  if (!domain) return maskTail(email);
  return `${user.slice(0, 2)}***@${domain}`;
};

module.exports = { sleep, now, maskTail, maskEmail };
