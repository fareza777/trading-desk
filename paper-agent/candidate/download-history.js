#!/usr/bin/env node
// Public, read-only OKX spot history. Snapshot `to` is an exclusive UTC boundary.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const SCRIPT = fileURLToPath(import.meta.url);
const CANDIDATE = path.dirname(SCRIPT);
const require = createRequire(import.meta.url);
const ccxt = require(path.resolve(CANDIDATE, '../../ccxt-mcp/node_modules/ccxt/dist/ccxt.cjs'));
const HOUR = 3_600_000;
const PAGE_LIMIT = 300;
const SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'LINK/USDT', 'AVAX/USDT'];
const iso = value => value === null ? null : new Date(value).toISOString();
const describeError = error => `${error.name || 'Error'}: ${error.message || error}`.slice(0, 300);

export function parseArgs(args) {
  const result = { days: 220, out: path.join(CANDIDATE, 'history.json'), help: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help') {
      result.help = true;
      continue;
    }
    if (!['--days', '--out'].includes(flag) || seen.has(flag)) {
      throw new Error(`Unknown or repeated argument: ${flag}`);
    }
    seen.add(flag);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag === '--days') {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
        throw new Error('--days must be a positive whole number');
      }
      result.days = Number(value);
    } else {
      result.out = path.resolve(CANDIDATE, value);
    }
  }
  return result;
}

export async function checkOutput(destination) {
  const root = await fs.realpath(CANDIDATE);
  const relative = path.relative(CANDIDATE, destination);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('--out must be strictly within candidate');
  }
  if (path.extname(destination).toLowerCase() !== '.json') throw new Error('--out must be a .json file');
  // Resolve existing parent directories to reject symlink/junction escapes as well.
  const parent = await fs.realpath(path.dirname(destination));
  const realRelative = path.relative(root, parent);
  if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error('--out parent resolves outside candidate');
  }
  const canonical = path.join(parent, path.basename(destination));
  try {
    await fs.lstat(canonical);
  } catch (error) {
    if (error.code === 'ENOENT') return canonical;
    throw error;
  }
  throw new Error(`Refusing to overwrite existing snapshot: ${canonical}; choose an unused --out path`);
}

async function retryPublic(operation, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const transient = error instanceof ccxt.NetworkError || error instanceof ccxt.RateLimitExceeded;
      if (!transient || attempt === 3) throw error;
      console.error(`${label}: ${describeError(error)}; retry ${attempt}/2`);
      await delay(1000 * 2 ** (attempt - 1));
    }
  }
}

export function validateRows(rows, from, to) {
  const first = rows.length ? rows[0][0] : null;
  const last = rows.length ? rows[rows.length - 1][0] : null;
  const expected = (to - from) / HOUR;
  let gaps = 0;
  let gapCandles = 0;
  const gapExamples = [];
  for (let i = 1; i < rows.length; i++) {
    const missing = (rows[i][0] - rows[i - 1][0]) / HOUR - 1;
    if (missing > 0) {
      gaps++;
      gapCandles += missing;
      if (gapExamples.length < 3) {
        gapExamples.push({ from: iso(rows[i - 1][0] + HOUR), to: iso(rows[i][0]), candles: missing });
      }
    }
  }
  const leadingMissing = first === null ? expected : (first - from) / HOUR;
  const trailingMissing = last === null ? 0 : (to - last - HOUR) / HOUR;
  const complete = rows.length === expected && first === from && last === to - HOUR && gaps === 0;
  return {
    complete, candles: rows.length, expected, first: iso(first), last: iso(last),
    missing: expected - rows.length, leadingMissing, trailingMissing, gaps, gapCandles, gapExamples,
  };
}

export async function downloadSymbol(exchange, symbol, from, to) {
  const candles = new Map();
  const stats = { requests: 0, invalid: 0, unconfirmed: 0, outOfRange: 0, duplicates: 0, stop: null };
  let cursor = from;
  try {
    const market = exchange.market(symbol);
    if (!market.spot) throw new Error(`${symbol} is not a spot market`);
    while (cursor < to) {
      let pageEnd = Math.min(cursor + PAGE_LIMIT * HOUR, to);
      // If an endpoint returns only the newest portion of a window, fill its
      // missing prefix before advancing. Never assume a short page is the end.
      for (const timestamp of candles.keys()) {
        if (timestamp > cursor && timestamp < pageEnd) pageEnd = timestamp;
      }
      const response = await retryPublic(() => {
        stats.requests++;
        return exchange.publicGetMarketHistoryCandles({
          instId: market.id, bar: '1H', limit: String(PAGE_LIMIT),
          before: String(cursor - 1), after: String(pageEnd),
        });
      }, `${symbol} ${iso(cursor)}`);
      if (!Array.isArray(response?.data)) throw new Error('OKX returned no candle data array');
      if (!response.data.length) {
        stats.stop = `Empty page at ${iso(cursor)} before requested end`;
        break;
      }
      const sizeBefore = candles.size;
      for (const raw of response.data) {
        if (!Array.isArray(raw) || raw.length < 9) {
          stats.invalid++;
          continue;
        }
        const row = exchange.parseOHLCV(raw, market);
        if (row.length !== 6 || !row.every(Number.isFinite)) {
          stats.invalid++;
          continue;
        }
        const [timestamp, open, high, low, close, volume] = row;
        if (!Number.isSafeInteger(timestamp) || timestamp % HOUR !== 0 ||
            Math.min(open, high, low, close) <= 0 || volume < 0 ||
            high < Math.max(open, low, close) || low > Math.min(open, high, close)) {
          stats.invalid++;
          continue;
        }
        // Require both OKX's final-candle flag and a fully elapsed hour.
        if (String(raw[8]) !== '1' || timestamp + HOUR > to) {
          stats.unconfirmed++;
          continue;
        }
        if (timestamp < from || timestamp >= to) {
          stats.outOfRange++;
          continue;
        }
        if (candles.has(timestamp)) {
          stats.duplicates++;
          if (candles.get(timestamp).some((value, index) => value !== row[index])) {
            throw new Error(`Conflicting duplicate candle at ${iso(timestamp)}`);
          }
          continue;
        }
        if (timestamp < cursor || timestamp >= pageEnd) {
          stats.outOfRange++;
          continue;
        }
        candles.set(timestamp, row);
      }
      while (candles.has(cursor)) cursor += HOUR;
      if (candles.size === sizeBefore) {
        stats.stop = `No new valid closed candles at ${iso(cursor)} before requested end`;
        break;
      }
    }
  } catch (error) {
    stats.stop = describeError(error);
  }
  const rows = [...candles.values()].sort((a, b) => a[0] - b[0]);
  const validation = validateRows(rows, from, to);
  return { rows, summary: { symbol, ...validation, ...stats } };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node download-history.js [--days N] [--out path]\n' +
      'Defaults: 220 whole days, candidate/history.json. Relative outputs are candidate-relative.\n' +
      'Existing files are never overwritten. from is inclusive; to is the exclusive UTC hour boundary.\n' +
      'Exit 0 = complete; 2 = partial snapshot (see per-symbol validation); 1 = setup/write failure.');
    return;
  }
  const destination = await checkOutput(args.out);
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('Refusing to run with TLS verification disabled');
  }
  const exchange = new ccxt.okx({
    enableRateLimit: true, rateLimit: 200, timeout: 30_000,
    validateServerSsl: true, verbose: false,
    options: { defaultType: 'spot', fetchMarkets: { types: ['spot'] }, maxRetriesOnFailure: 0 },
  });
  exchange.has.fetchCurrencies = false; // OKX's currency endpoint is authenticated; never call it.
  const sign = exchange.sign.bind(exchange);
  const allowed = new Set(['public/time', 'public/instruments', 'market/history-candles']);
  exchange.sign = (endpoint, api = 'public', method = 'GET', ...rest) => {
    if (api !== 'public' || method !== 'GET' || !allowed.has(endpoint)) {
      throw new Error('Blocked request outside the public market-data allowlist');
    }
    const request = sign(endpoint, api, method, ...rest);
    const url = new URL(request.url);
    if (url.protocol !== 'https:' || url.hostname !== 'www.okx.com') {
      throw new Error('Blocked non-HTTPS or non-OKX request');
    }
    return request;
  };
  try {
    const serverTime = await retryPublic(() => exchange.fetchTime(), 'OKX server time');
    if (!Number.isSafeInteger(serverTime) || serverTime <= 0) throw new Error('Invalid OKX server time');
    const to = Math.floor(serverTime / HOUR) * HOUR;
    const from = to - args.days * 24 * HOUR;
    if (!Number.isSafeInteger(from) || from < 0) throw new Error('--days places the start before the Unix epoch');
    const clockSkewMs = serverTime - Date.now();
    console.log(JSON.stringify({ exchange: 'okx', timeframe: '1h', days: args.days,
      from: iso(from), toExclusive: iso(to), lastClosedCandle: iso(to - HOUR),
      expectedPerSymbol: args.days * 24, clockSkewMs: Math.round(clockSkewMs) }));
    await retryPublic(() => exchange.loadMarkets(), 'OKX spot markets');
    const snapshot = { exchange: 'okx', downloadedAt: null, timeframe: '1h', from, to, symbols: {} };
    let complete = true;
    for (const symbol of SYMBOLS) {
      const result = await downloadSymbol(exchange, symbol, from, to);
      snapshot.symbols[symbol] = result.rows;
      console.log(JSON.stringify(result.summary));
      if (!result.summary.complete || result.summary.stop) complete = false;
    }
    snapshot.downloadedAt = new Date().toISOString();
    // Recheck containment and existence after networking, then exclusive-create.
    // No temporary files, overwrite option, config changes, or ledger access.
    const checkedDestination = await checkOutput(args.out);
    if (checkedDestination !== destination) throw new Error('Output parent changed during download');
    const output = await fs.open(destination, 'wx', 0o600);
    try {
      await output.writeFile(JSON.stringify(snapshot) + '\n', 'utf8');
      await output.sync();
    } finally {
      await output.close();
    }
    console.log(JSON.stringify({ saved: destination, status: complete ? 'complete' : 'PARTIAL',
      note: complete ? 'All requested closed candles present; no gaps.' :
        'Requested bounds retained; missing candles are not filled. Do not treat this snapshot as complete.' }));
    if (!complete) process.exitCode = 2;
  } finally {
    await exchange.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  main().catch(error => {
    console.error(describeError(error));
    process.exitCode = 1;
  });
}
