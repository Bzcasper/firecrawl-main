#!/usr/bin/env node

/**
 * proxyManager.js
 *
 * 1. Checks every 10 minutes if the current PROXY_SERVER in .env is still valid.
 * 2. If not valid (or missing), it fetches fresh proxies from two GitHub sources,
 *    tests them, picks one, and injects into .env as "PROXY_SERVER".
 * 3. Writes all valid proxies to output/valid_proxies.txt (for reference).
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

// GitHub raw URLs for http.txt
const GITHUB_SOURCES = [
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/Zaeem20/FREE_PROXIES_LIST/master/http.txt',
];

// Where we will save valid proxies
const OUTPUT_DIR = 'output';
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'valid_proxies.txt');

// We’ll check the current .env proxy validity every 10 minutes (in ms):
const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

// The test URL for checking if a proxy is valid:
const TEST_URL = 'https://httpbin.org/ip';

// The .env key to store our chosen proxy under:
const ENV_KEY = 'PROXY_SERVER';

// Make sure we have an output dir
function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    console.log(`[INFO] Created directory: ${OUTPUT_DIR}`);
  }
}

/**
 * Load the current PROXY_SERVER from .env
 * Return null if not found.
 */
function getCurrentProxyFromEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    return null;
  }
  const envLines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (let line of envLines) {
    line = line.trim();
    if (line.startsWith(`${ENV_KEY}=`)) {
      return line.split('=')[1];
    }
  }
  return null;
}

/**
 * Write a new PROXY_SERVER into .env, removing old references.
 */
function setEnvProxy(proxyUrl) {
  const envPath = path.join(process.cwd(), '.env');
  let envLines = [];
  if (fs.existsSync(envPath)) {
    envLines = fs.readFileSync(envPath, 'utf-8').split('\n');
  }
  // Filter out old line that starts with "PROXY_SERVER="
  envLines = envLines.filter(line => !line.startsWith(`${ENV_KEY}=`));
  // Add new line
  envLines.push(`${ENV_KEY}=${proxyUrl}`);
  // Save
  fs.writeFileSync(envPath, envLines.join('\n'));
  console.log(`[INFO] Updated .env => ${ENV_KEY}=${proxyUrl}`);
}

/**
 * Validate a single proxy by sending a request to TEST_URL.
 * Return true if status=200, else false.
 */
async function validateSingleProxy(proxyUrl) {
  try {
    const [protocol] = proxyUrl.split('://');
    const agent = protocol === 'https'
      ? new HttpsProxyAgent(proxyUrl)
      : new HttpProxyAgent(proxyUrl);

    const resp = await axios.get(TEST_URL, {
      timeout: 5000,
      httpAgent: agent,
      httpsAgent: agent,
    });
    if (resp.status === 200) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Fetch proxies from the GitHub sources and parse them.
 * Each file is lines of "IP:PORT".
 * We'll prefix them with "http://" since they are HTTP proxies.
 */
async function fetchGitHubProxies() {
  console.log('[INFO] Fetching proxies from GitHub sources...');
  const allProxies = new Set();

  for (const src of GITHUB_SOURCES) {
    try {
      console.log(`   -> GET ${src}`);
      const resp = await axios.get(src, { timeout: 15000 });
      if (resp.status === 200 && resp.data) {
        // Each line is e.g. "1.2.3.4:8080"
        const lines = resp.data.split('\n').map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
          // If the line doesn't already have protocol, prefix with http://
          // We'll assume HTTP. If you know these are HTTPS, adjust accordingly.
          if (!line.includes('://')) {
            allProxies.add(`http://${line}`);
          } else {
            // In case the list has something like "https://..."
            allProxies.add(line);
          }
        }
      }
    } catch (error) {
      console.warn(`[WARN] Could not fetch from ${src} => ${error.message}`);
    }
  }

  const result = [...allProxies];
  console.log(`[INFO] Total proxies fetched: ${result.length}`);
  return result;
}

/**
 * Validate a bunch of proxies and return the ones that are valid.
 * We'll stop once we find 100 valid or exhaust the list (adjust as needed).
 */
async function validateProxies(proxyList) {
  const valid = [];
  console.log('[INFO] Validating fetched proxies...');
  for (const proxy of proxyList) {
    if (valid.length >= 100) break; // Arbitrary limit to avoid testing too many
    const isOk = await validateSingleProxy(proxy);
    if (isOk) {
      console.log(`[OK] ${proxy}`);
      valid.push(proxy);
    } else {
      console.log(`[FAIL] ${proxy}`);
    }
  }
  console.log(`[INFO] Found ${valid.length} valid proxies.`);
  return valid;
}

/**
 * Main function to fetch, validate, pick a random valid proxy,
 * update .env, and write out a text file for reference.
 */
async function scrapeValidateAndInject() {
  // 1) Fetch
  const allProxies = await fetchGitHubProxies();
  if (!allProxies.length) {
    console.error('[ERROR] No proxies found from GitHub sources.');
    return false;
  }

  // 2) Validate
  const valid = await validateProxies(allProxies);
  if (!valid.length) {
    console.error('[ERROR] No valid proxies after testing.');
    return false;
  }

  // 3) Write them to output/valid_proxies.txt
  fs.writeFileSync(OUTPUT_FILE, valid.join('\n'), 'utf-8');
  console.log(`[INFO] Wrote valid proxies to: ${OUTPUT_FILE}`);

  // 4) Choose one at random and set it in .env
  const chosen = valid[Math.floor(Math.random() * valid.length)];
  setEnvProxy(chosen);
  return true;
}

/**
 * Check if the currently set PROXY_SERVER in .env is valid.
 * If not, re-scrape and set a new one.
 */
async function checkCurrentProxy() {
  const currentProxy = getCurrentProxyFromEnv();
  if (!currentProxy) {
    console.log('[INFO] No PROXY_SERVER found in .env. Scraping and validating...');
    await scrapeValidateAndInject();
  } else {
    const stillGood = await validateSingleProxy(currentProxy);
    if (!stillGood) {
      console.log(`[WARN] Current PROXY_SERVER is no longer valid. Getting a new one...`);
      await scrapeValidateAndInject();
    } else {
      console.log(`[INFO] Current PROXY_SERVER still valid: ${currentProxy}`);
    }
  }
}

/* -------------------------------------------------------------------
   MAIN LOGIC: Runs on start, then every 10 minutes.
 ------------------------------------------------------------------- */
async function main() {
  ensureOutputDir();

  // 1) Run immediately on startup
  await checkCurrentProxy();

  // 2) Then check every 10 minutes
  setInterval(async () => {
    await checkCurrentProxy();
  }, CHECK_INTERVAL_MS);
}

// If you run this file directly (e.g. `node proxyManager.js`), start `main()`
if (require.main === module) {
  main().catch(err => {
    console.error('[FATAL]', err);
    process.exit(1);
  });
}
