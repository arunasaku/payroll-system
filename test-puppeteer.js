const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', error => console.log('PAGE ERROR:', error.message));
  page.on('requestfailed', request => console.log('REQUEST FAILED:', request.url(), request.failure().errorText));
  
  await page.goto('file:///D:/Projects/payroll-system/index.html', { waitUntil: 'networkidle0' });
  
  // Click the EPF cheque button
  console.log('Clicking EPF cheque button...');
  await page.evaluate(() => {
      document.getElementById('btn-print-epf-cheque').click();
  });
  
  await new Promise(r => setTimeout(r, 2000));
  await browser.close();
})();
