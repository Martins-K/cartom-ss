/**
 * authenticate.js - Puppeteer-based authentication
 *
 * Purpose: Only handles logging in and saving cookies
 * Run this when you need to authenticate or refresh cookies
 *
 * Usage: node authenticate.js
 */

require('dotenv').config({ override: false });
const fs = require('fs');

async function authenticate(phoneNumber, password, options = {}) {
  const { headless = true, verbose = true } = options;

  const log = (...args) => {
    if (verbose) console.log(...args);
  };

  let puppeteer;
  try {
    puppeteer = await import('puppeteer');
  } catch (error) {
    console.error('❌ Puppeteer not installed!');
    console.error('Run: npm install puppeteer');
    process.exit(1);
  }

  log('🚀 Launching browser...');
  const browser = await puppeteer.default.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--window-size=1366,768',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
    });

    // Remove webdriver detection
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
    });

    log('📄 Navigating to login page...');
    await page.goto('https://www.ss.lv/lv/login/', {
      waitUntil: 'networkidle2',
    });

    log('⌨️  Entering credentials...');
    await page.evaluate(
      (phone, pass) => {
        const phoneField = document.querySelector('#login_txt');
        const passField = document.querySelector('#pass_txt');

        const fillField = (field, value) => {
          field.focus();
          field.value = value;
          field.dispatchEvent(new Event('focus', { bubbles: true }));
          field.dispatchEvent(new Event('input', { bubbles: true }));
          field.dispatchEvent(new Event('change', { bubbles: true }));
          field.dispatchEvent(new Event('blur', { bubbles: true }));
        };

        fillField(phoneField, phone);
        fillField(passField, pass);
      },
      phoneNumber,
      password
    );
    await new Promise((resolve) => setTimeout(resolve, 500));

    const fieldValues = await page.evaluate(() => ({
      phone: document.querySelector('#login_txt')?.value,
      passLength: document.querySelector('#pass_txt')?.value?.length,
    }));
    log(
      `   ✓ Phone field: "${fieldValues.phone}", Password length: ${fieldValues.passLength}`
    );

    log('🔘 Submitting login...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }),
      page.click('input[name="blogin"]'),
    ]);

    const currentUrl = page.url();
    log('📍 Final URL:', currentUrl);

    // Check if login failed
    if (currentUrl.includes('/login/')) {
      const errorMessage = await page.evaluate(() => {
        const scripts = Array.from(document.querySelectorAll('script'));
        for (const script of scripts) {
          const match = script.textContent.match(/_alert\('([^']+)'\)/);
          if (match) return match[1];
        }
        return null;
      });

      await browser.close();
      throw new Error(errorMessage || 'Login failed - check credentials');
    }

    // Verify successful login
    const pageContent = await page.content();
    const hasLogout =
      pageContent.includes('Izeja') || pageContent.includes('/lv/logout/');

    if (!hasLogout) {
      await browser.close();
      throw new Error('Login validation failed - no logout link found');
    }

    log('✅ Login successful!');

    // Get cookies
    const cookies = await page.cookies();
    const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    const cookieData = {
      timestamp: new Date().toISOString(),
      expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      cookies: cookies,
      cookieString: cookieString,
    };

    fs.writeFileSync(
      './ss-lv-cookies.json',
      JSON.stringify(cookieData, null, 2)
    );
    log('💾 Cookies saved: ss-lv-cookies.json');

    await browser.close();

    return {
      success: true,
      cookies: cookies,
      cookieString: cookieString,
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function main() {
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║   SS.LV Authentication (Puppeteer)        ║');
  console.log('╚════════════════════════════════════════════╝\n');

  const PHONE_NUMBER = process.env.SS_LV_PHONE;
  const PASSWORD = process.env.SS_LV_PASSWORD;

  if (!PHONE_NUMBER || !PASSWORD) {
    console.error('❌ Missing SS_LV_PHONE or SS_LV_PASSWORD in environment');
    process.exit(1);
  }

  try {
    const result = await authenticate(PHONE_NUMBER, PASSWORD, {
      headless: true,
      verbose: true,
    });

    console.log('\n✅ Authentication complete!');
    console.log('Cookie string:', result.cookieString.substring(0, 80) + '...');
  } catch (error) {
    console.error('\n❌ Authentication failed!');
    console.error('Error:', error.message);
    process.exit(1);
  }
}

module.exports = { authenticate };

if (require.main === module) {
  main();
}
