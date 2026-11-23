import {kaggleAccessToken} from './kaggle-oauth.js';
// Service names, request fields and host follow Kaggle's official Python SDK.
// No retry/fallback for SaveKernel: an uncertain response may still create a run.
export const API_ROOT = 'https://api.kaggle.com/v1/kernels.KernelsApiService/';
export const BUILD = '0.3.0';
export {normalizeKernelRef,settingsFromSource} from '../../shared/notebooks.mjs';
export class KaggleError extends Error {
  constructor(message, details = {}) { super(message); Object.assign(this, {status: 502, ...details}); }
}
export function redact(value, env) {
  let s = String(value ?? '');
  for (const key of ['ADMIN_TOKEN', 'MODEL_API_KEY', 'KAGGLE_API_TOKEN', 'CF_TUNNEL_TOKEN', 'RUN_TOKEN']) {
    if (env[key]) s = s.split(env[key]).join('[redacted]');
  }
  return s.replace(/KGAT_[\w-]+/gi, '[redacted]')
    .replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [redacted]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 400);
}
export async function kaggleRpc(env, operation, body = {}) {
  const allowed = ['ListKernels', 'SaveKernel', 'GetKernel', 'GetKernelSessionStatus', 'GetAcceleratorQuotaStatistics'];
  if (!allowed.includes(operation)) throw new KaggleError('Unsupported Kaggle operation');
  const accessToken = await kaggleAccessToken(env);
  let r;
  try {
    r = await fetch(API_ROOT + operation, {method: 'POST', redirect: 'manual',
      headers: {authorization: 'Bearer ' + accessToken, 'content-type': 'application/json',
        accept: 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(25000)});
  } catch (e) {
    const timeout = ['TimeoutError', 'AbortError'].includes(e?.name);
    throw new KaggleError(operation + (timeout ? ': timed out after 25 seconds' : ': network connection failed'),
      {operation, kind: timeout ? 'timeout' : 'network'});
  }
  if (r.status >= 300 && r.status < 400) {
    // Do not follow redirects with a credential or notebook source code.
    let host = 'unknown';
    try { host = new URL(r.headers.get('location'), API_ROOT).hostname; } catch {}
    await r.body?.cancel();
    throw new KaggleError(`${operation}: HTTP ${r.status}, redirect to ${host} blocked`,
      {operation, http_status: r.status, kind: 'redirect'});
  }
  let data;
  try { data = await r.json(); }
  catch (e) {
    throw new KaggleError(`${operation}: HTTP ${r.status}, expected JSON response`,
      {operation, http_status: r.status, kind: 'non_json'});
  }
  if (!r.ok || (typeof data?.code === 'number' && data.code >= 400) || data?.error?.code >= 400) {
    const hint = r.status === 401 ? 'Check the Kaggle token.' : r.status === 403 ? 'Check account permissions and verification.' : '';
    const upstreamMessage = data?.message || data?.error?.message;
    const message = typeof upstreamMessage === 'string' ? redact(upstreamMessage, {...env, KAGGLE_API_TOKEN: accessToken}) : '';
    throw new KaggleError(`${operation}: HTTP ${r.status}. ${hint} ${message}`.trim(),
      {operation, http_status: r.status, kind: 'http'});
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new KaggleError(operation + ': unexpected JSON shape', {operation, kind: 'schema'});
  }
  return data;
}
export async function listOwnKernels(env) {
  const data = await kaggleRpc(env, 'ListKernels', {group: 'PROFILE', page: 1, pageSize: 20});
  // An empty proto repeated field may be omitted from the JSON object.
  if (data.kernels !== undefined && !Array.isArray(data.kernels)) {
    throw new KaggleError('ListKernels: unexpected kernels field', {kind: 'schema'});
  }
  return data.kernels || [];
}
