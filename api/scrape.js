// api/scrape.js  — Vercel serverless function
// Uses puppeteer-core + @sparticuz/chromium to render JS-heavy pages
// like JustDial, IndiaMart, etc. and return their visible text content

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

// Realistic browser headers to avoid blocks
const HEADERS = {
  'Accept-Language': 'en-IN,en;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'DNT': '1',
  'Upgrade-Insecure-Requests': '1',
};

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

module.exports = async (req, res) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { url, waitFor, scrollPages } = req.body || {};

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  // Validate URL
  try { new URL(url); } catch(e) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  let browser = null;

  try {
    // Launch chromium
    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote',
      ],
      defaultViewport: { width: 1280, height: 900 },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    // Set realistic user agent and headers
    await page.setUserAgent(USER_AGENT);
    await page.setExtraHTTPHeaders(HEADERS);

    // Block images, fonts, media to speed up load
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const rt = req.resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(rt)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Navigate to page
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // Wait for listing content to load
    // Different wait selectors for different sites
    const hostname = new URL(url).hostname;

    if (hostname.includes('justdial')) {
      // Wait for JustDial listing cards
      try {
        await page.waitForSelector('.resultbox_info, .jsx-3b4bee2e2e7e6ccc, [class*="resultbox"]', { timeout: 8000 });
      } catch(e) { /* Continue even if selector not found */ }
    } else if (hostname.includes('indiamart')) {
      try {
        await page.waitForSelector('.bname, .company-name, [class*="bname"]', { timeout: 8000 });
      } catch(e) {}
    } else if (hostname.includes('sulekha')) {
      try {
        await page.waitForSelector('.sp-name, .service-provider-name', { timeout: 8000 });
      } catch(e) {}
    }

    // Scroll down to trigger lazy loading (load more listings)
    const scrollCount = scrollPages || 3;
    for (let i = 0; i < scrollCount; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await new Promise(r => setTimeout(r, 1200));
    }

    // Extract both text content AND structured data
    const result = await page.evaluate(() => {
      // Get all visible text
      const bodyText = document.body.innerText;

      // Try to extract structured listing data directly from DOM
      const listings = [];

      // JustDial specific extraction
      const jdCards = document.querySelectorAll('.resultbox_info, [class*="resultbox_info"]');
      if (jdCards.length > 0) {
        jdCards.forEach(card => {
          const name = card.querySelector('[class*="resultbox_title"], .fn, h2')?.innerText?.trim();
          const phone = card.querySelector('[class*="callcontent"], .mobilesv, [class*="phone"]')?.innerText?.trim()
                     || card.querySelector('a[href^="tel:"]')?.href?.replace('tel:','');
          const rating = card.querySelector('[class*="resultbox_totalrate"], .ratingcount, [class*="ratingcount"]')?.innerText?.trim();
          const address = card.querySelector('[class*="resultbox_address"], .mrehover, [class*="address"]')?.innerText?.trim();
          const category = card.querySelector('[class*="resultbox_cate"], .category, [class*="cate"]')?.innerText?.trim();
          const reviews = card.querySelector('[class*="resultbox_ratinginfo"], [class*="ratinginfo"]')?.innerText?.trim();
          if (name) {
            listings.push({ name, phone, rating, address, category, reviews });
          }
        });
      }

      // IndiaMart specific extraction
      const imCards = document.querySelectorAll('.bname, [class*="producthide"]');
      if (imCards.length > 0) {
        imCards.forEach(card => {
          const name = card.querySelector('.bname, .companyname')?.innerText?.trim();
          const phone = card.querySelector('[class*="phone"], .phone')?.innerText?.trim();
          if (name) listings.push({ name, phone });
        });
      }

      return {
        text: bodyText,
        title: document.title,
        url: window.location.href,
        listingsFound: listings.length,
        structuredData: listings,
        htmlLength: document.body.innerHTML.length,
      };
    });

    await browser.close();
    browser = null;

    return res.status(200).json({
      success: true,
      url: result.url,
      title: result.title,
      text: result.text,
      textLength: result.text.length,
      listingsFound: result.listingsFound,
      structuredData: result.structuredData,
      htmlLength: result.htmlLength,
    });

  } catch (error) {
    if (browser) {
      try { await browser.close(); } catch(e) {}
    }
    console.error('Scrape error:', error.message);
    return res.status(500).json({
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
};
