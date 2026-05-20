import { HttpsProxyAgent } from 'https-proxy-agent';
import nodeFetch from 'node-fetch';

const agent = new HttpsProxyAgent('http://127.0.0.1:10809');

console.log('Testing node-fetch + HttpsProxyAgent...');
try {
  const r = await nodeFetch('https://httpbin.org/get', { agent });
  console.log('Status:', r.status);
  const body = await r.json();
  console.log('Origin:', body.origin);
} catch (e) {
  console.log('Error:', e.code || e.cause?.code, String(e.message || '').slice(0, 120));
}
