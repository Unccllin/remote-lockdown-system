const { chromium } = require('@playwright/test');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const baseUrl = 'http://localhost:5173';
  const apiBase = 'http://localhost:3001';

  // Login via API to get token
  const loginResp = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const { token } = await loginResp.json();
  console.log('Logged in, token:', token?.slice(0, 20) + '...');

  // Inject token into localStorage before navigating
  await page.addInitScript((t) => {
    localStorage.setItem('token', t);
  }, token);

  const screenshots = [
    { name: 'login', path: '/login' },
    { name: 'overview', path: '/' },
    { name: 'devices', path: '/devices' },
    { name: 'device-detail', path: '/devices' }, // will click first device
    { name: 'enroll', path: '/enroll' },
    { name: 'audit', path: '/audit' },
    { name: 'map', path: '/map' },
    { name: 'health', path: '/health' },
    { name: 'admins', path: '/admins' },
  ];

  // Take login page screenshot (no token)
  await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: '/tmp/dashboard-login.png', fullPage: true });
  console.log('Saved: login');

  // Now navigate to authenticated pages
  for (const s of screenshots.slice(1)) {
    await page.goto(`${baseUrl}${s.path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `/tmp/dashboard-${s.name}.png`, fullPage: true });
    console.log(`Saved: ${s.name}`);
  }

  // Try clicking first device for detail view
  await page.goto(`${baseUrl}/devices`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const deviceLink = await page.$('a[href*="/devices/"]');
  if (deviceLink) {
    await deviceLink.click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: '/tmp/dashboard-device-detail.png', fullPage: true });
    console.log('Saved: device-detail (clicked)');
  }

  await browser.close();
  console.log('Done — screenshots in /tmp/dashboard-*.png');
})();
