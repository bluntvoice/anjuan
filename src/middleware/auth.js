// Phase 1 identity authentication. Unreviewed business APIs are gated separately.
import crypto from 'node:crypto';
import { audit } from '../db.js';
import passwordHash from '../lib/password-hash.cjs';
import { identity } from '../lib/identity.js';
import { normalizedUsername } from '../lib/identity-service.js';
import { trackAuthConnection } from '../lib/auth-connections.js';
import { unsafeNoAuthAllowed } from '../lib/startup-config.js';
const LOGIN_FAILS=5, LOGIN_WINDOW_MS=15*60*1000, LOGIN_LOCK_MS=LOGIN_WINDOW_MS, LOGIN_FAIL_CAPACITY=2048;
const fails=new Map();
export const DEFAULT_ACTOR='web';
export const {hashPassword,parsePasswordHash,verifyPassword,verifyPasswordDetailed}=passwordHash;
export function secretMatches(candidate,expected) {
  const digest=value=>crypto.createHash('sha256').update(String(value ?? ''),'utf8').digest();
  const same=crypto.timingSafeEqual(digest(candidate),digest(expected));
  return typeof expected==='string' && expected.length>0 && same;
}
// Legacy credential verification is retained for migration compatibility tests only.
// No production login route calls this env-based helper.
export function verifyLoginCredentials(username,password,env=process.env) {
  const result=verifyPasswordDetailed(password || '',env.ANJIAN_PASS_HASH);
  return {ok:secretMatches(username,env.ANJIAN_USER)&&result.ok,legacy:result.legacy};
}
export function parseCookies(req) {
  const out={};
  for(const kv of (req.headers.cookie || '').split(';')) {
    const index=kv.indexOf('='); if(index>0) out[kv.slice(0,index).trim()]=kv.slice(index+1).trim();
  }
  return out;
}
export function setSessionCookie(res,req,token,maxAge=2592000) {
  res.setHeader('Set-Cookie','anjian_sess='+token+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+maxAge+(req.secure?'; Secure':''));
}
export function destroySession(req,res) {
  identity.logout(parseCookies(req).anjian_sess,{requestId:req.requestId,excludeResponse:res});
  setSessionCookie(res,req,'',0);
}
function pruneLoginFails(now) {
  for (const [key, state] of fails) {
    if (state.expiresAt <= now) fails.delete(key);
  }
}

function loginFailKey(req) {
  let username = String(req.body?.username || '').slice(0, 128);
  try { username = normalizedUsername(username).normalized; } catch { /* keep a bounded invalid-name bucket */ }
  return JSON.stringify([req.ip || '?', username]);
}

export function loginLimiter(req, res, next) {
  const now = Date.now();
  pruneLoginFails(now);
  const key = loginFailKey(req);
  const f = fails.get(key);
  if (f && f.lockUntil > now) {
    res.setHeader('Retry-After', String(Math.ceil((f.lockUntil - now) / 1000)));
    return res.status(429).json({ error: '尝试过多，15 分钟后再试' });
  }
  if (!f && fails.size >= LOGIN_FAIL_CAPACITY) {
    res.setHeader('Retry-After', String(LOGIN_WINDOW_MS / 1000));
    return res.status(429).json({ error: '登录请求过多，请稍后再试' });
  }
  req._loginIp = req.ip || '?';
  req._loginKey = key;
  next();
}

export function recordLoginFail(key) {
  if (!key) return;
  const now = Date.now();
  let f = fails.get(key);
  if (!f || f.expiresAt <= now || now - f.windowStartedAt >= LOGIN_WINDOW_MS) {
    f = { count: 0, windowStartedAt: now, lockUntil: 0, expiresAt: now + LOGIN_WINDOW_MS };
  }
  f.count += 1;
  if (f.count >= LOGIN_FAILS) {
    f.count = 0;
    f.lockUntil = now + LOGIN_LOCK_MS;
    f.expiresAt = f.lockUntil;
  }
  fails.delete(key);
  fails.set(key, f);
}

export function clearLoginFail(key) {
  fails.delete(key);
}


export function apiAuth(req,res,next) {
  if(unsafeNoAuthAllowed()) { req.actor='isolated-test'; return next(); }
  const token=parseCookies(req).anjian_sess;
  const found=identity.session(token,{renew:true});
  if(!found) return res.status(401).json({error:'unauthorized'});
  req.user=found.user; req.actor=found.user.id; req.authSession=found;
  req.requestId=crypto.randomUUID();
  if(found.renewed) setSessionCookie(res,req,token);
  trackAuthConnection(req,res,found,()=>Boolean(identity.session(token)));
  next();
}
export function pageAuth(req,res,next) {
  if(unsafeNoAuthAllowed()) return next();
  const open=req.path==='/login.html' || req.path.startsWith('/css/') || req.path.startsWith('/js/')
    || req.path.startsWith('/assets/') || req.path==='/favicon.ico';
  if(open) return next();
  const session=identity.session(parseCookies(req).anjian_sess);
  if(!session) return res.redirect('/login.html');
  if(req.path==='/' || req.path==='/index.html') return res.redirect('/users.html');
  if(req.path==='/users.html') return next();
  return res.status(403).send('此业务功能尚未开放');
}
export function internalAuth(req,res,next) {
  if(unsafeNoAuthAllowed()) {req.actor='isolated-test';return next();}
  return res.status(403).json({error:'内部自动化接口尚未开放',code:'feature_disabled'});
}
export function phase1BusinessGate(req,res,next) {
  if(unsafeNoAuthAllowed()) return next();
  return res.status(403).json({error:'业务权限尚未开放',code:'phase1_business_closed'});
}
export function requestBoundary(req,res,next) {
  const host=req.get('host') || '';
  const port=req.socket.localPort;
  const allowed=new Set(['127.0.0.1:'+port,'localhost:'+port,'[::1]:'+port]);
  if(!allowed.has(host)) return res.status(403).json({error:'请求来源不正确',code:'request_origin_invalid'});
  const origin=req.get('origin');
  if(origin && origin!=='http://'+host) return res.status(403).json({error:'请求来源不正确',code:'request_origin_invalid'});
  next();
}
export {audit};
