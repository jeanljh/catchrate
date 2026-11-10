// Demo shop: a static page and a tiny JSON API. Bound to 127.0.0.1 so nothing
// on the network can reach it.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4321);

// Fake token, there to show redaction working: it should appear as
// "[REDACTED]" in .catchrate/recordings/.
const user = { id: 'u_1001', name: 'Ada Lovelace', email: 'ada@example.com', plan: 'Pro', sessionToken: 'demo-session-1f9c2e7a4b' };

const cart = {
  currency: 'USD',
  items: [
    { sku: 'BK-101', name: 'Testing Handbook', price: 29.99, qty: 1 },
    { sku: 'MG-202', name: 'Coffee Mug', price: 12.5, qty: 2 },
    { sku: 'ST-303', name: 'Sticker Pack', price: 4.99, qty: 3 },
  ],
  subtotal: 69.96,
  discount: 5,
  total: 64.96,
};

const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'] };
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'",
};

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://${HOST}:${PORT}`);
  const asset = req.method === 'GET' ? STATIC[pathname] : undefined;
  if (asset) {
    res.writeHead(200, { 'content-type': asset[1], ...SECURITY_HEADERS });
    return fs.createReadStream(path.join(here, 'public', asset[0])).pipe(res);
  }
  if (req.method === 'GET' && pathname === '/api/user') return json(res, 200, user);
  if (req.method === 'GET' && pathname === '/api/cart') return json(res, 200, cart);
  if (req.method === 'POST' && pathname === '/api/checkout') {
    return json(res, 201, { status: 'confirmed', orderId: 'A-7731', total: cart.total, eta: '2-3 business days' });
  }
  json(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => console.log(`demo shop on http://${HOST}:${PORT}`));
