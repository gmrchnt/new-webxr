/**
 * server.js — Express backend for vendor search via Google Custom Search API
 *
 * Endpoints:
 *   POST /api/vendors  { damageType, vehicle? }
 *     → Returns { vendors: [...] } with real product listings
 *
 * Setup:
 *   1. Get a Google API key: https://console.cloud.google.com/apis/credentials
 *   2. Create a Custom Search Engine: https://programmablesearchengine.google.com/
 *      - Add sites: rockauto.com, autozone.com, amazon.com, tirerack.com, safelite.com
 *      - Or enable "Search the entire web" for broader results
 *   3. Set env vars:
 *      GOOGLE_API_KEY=your_key
 *      GOOGLE_CSE_ID=your_search_engine_id
 *
 * Run:
 *   node server.js         (starts on port 3001)
 *   npm run dev             (Vite on 5173, proxied to 3001)
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID || '';

// ── Search term mapping per damage type ──
const SEARCH_QUERIES = {
  glass_shatter: {
    base: 'car windshield replacement glass',
    partName: 'Windshield / Window Glass',
  },
  tire_flat: {
    base: 'car tire replacement',
    partName: 'Tire Replacement',
  },
  lamp_broken: {
    base: 'car headlight lamp assembly replacement',
    partName: 'Headlight / Lamp Assembly',
  },
};

// ── Fallback estimates when API is not configured or fails ──
const FALLBACKS = {
  glass_shatter: { min: 150, max: 400, partName: 'Windshield / Window Glass' },
  tire_flat:     { min: 60,  max: 200, partName: 'Tire Replacement' },
  lamp_broken:   { min: 40,  max: 250, partName: 'Headlight / Lamp Assembly' },
};

// ── In-memory cache (5 minute TTL) ──
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}

function setCache(key, data) {
  cache.set(key, { data, time: Date.now() });
}

// ── Main endpoint ──
app.post('/api/vendors', async (req, res) => {
  try {
    const { damageType, vehicle } = req.body;

    if (!SEARCH_QUERIES[damageType]) {
      return res.json({ vendors: [], fallbackEstimate: null, error: 'Unknown damage type' });
    }

    // Build search query
    const config = SEARCH_QUERIES[damageType];
    let query = config.base;
    if (vehicle?.make) query += ` ${vehicle.make}`;
    if (vehicle?.model) query += ` ${vehicle.model}`;
    if (vehicle?.year) query += ` ${vehicle.year}`;

    const cacheKey = `${damageType}|${query}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    // Check if API is configured
    if (!GOOGLE_API_KEY || !GOOGLE_CSE_ID) {
      console.warn('Google API not configured — returning fallback estimates');
      const fb = FALLBACKS[damageType];
      const result = {
        vendors: [],
        fallbackEstimate: {
          min: fb.min,
          max: fb.max,
          currency: 'USD',
          partName: fb.partName,
          note: 'Google API not configured — set GOOGLE_API_KEY and GOOGLE_CSE_ID env vars',
        },
      };
      return res.json(result);
    }

    // Call Google Custom Search API
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', GOOGLE_API_KEY);
    url.searchParams.set('cx', GOOGLE_CSE_ID);
    url.searchParams.set('q', query);
    url.searchParams.set('num', '10');

    const response = await fetch(url.toString());
    if (!response.ok) {
      const err = await response.text();
      console.error('Google API error:', response.status, err);
      throw new Error(`Google API returned ${response.status}`);
    }

    const data = await response.json();
    const vendors = parseSearchResults(data, config.partName);

    // Sort by price, take top 3
    vendors.sort((a, b) => a.price - b.price);
    const top3 = vendors.slice(0, 3);

    const result = top3.length > 0
      ? { vendors: top3, fallbackEstimate: null }
      : {
          vendors: [],
          fallbackEstimate: {
            min: FALLBACKS[damageType].min,
            max: FALLBACKS[damageType].max,
            currency: 'USD',
            partName: config.partName,
            note: 'No priced results found — showing market average estimates',
          },
        };

    setCache(cacheKey, result);
    res.json(result);
  } catch (error) {
    console.error('Vendor search error:', error.message);
    const fb = FALLBACKS[req.body?.damageType] || FALLBACKS.lamp_broken;
    res.json({
      vendors: [],
      fallbackEstimate: {
        min: fb.min,
        max: fb.max,
        currency: 'USD',
        partName: fb.partName,
        note: `Search failed: ${error.message}`,
      },
    });
  }
});

/**
 * Parse Google Custom Search results into vendor objects.
 * Extracts prices from snippets, titles, and pagemap data.
 */
function parseSearchResults(data, defaultPartName) {
  const vendors = [];
  if (!data.items) return vendors;

  for (const item of data.items) {
    const vendor = {
      name: extractVendorName(item),
      price: extractPrice(item),
      currency: 'USD',
      url: item.link,
      rating: extractRating(item),
      inStock: !/(out of stock|unavailable|sold out)/i.test(item.snippet || ''),
      partName: extractPartName(item, defaultPartName),
      deliveryDays: estimateDelivery(item),
    };

    // Only include if we found a valid price
    if (vendor.price > 0 && vendor.name) {
      vendors.push(vendor);
    }
  }

  return vendors;
}

function extractVendorName(item) {
  // Try to get site name from pagemap or display link
  const org = item.pagemap?.organization?.[0]?.name;
  if (org) return org;

  // Extract domain as vendor name
  try {
    const host = new URL(item.link).hostname.replace('www.', '');
    const parts = host.split('.');
    return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  } catch {
    return item.displayLink || 'Unknown';
  }
}

function extractPrice(item) {
  // Check pagemap for structured price data
  const offer = item.pagemap?.offer?.[0];
  if (offer?.price) return parseFloat(offer.price);

  const product = item.pagemap?.product?.[0];
  if (product?.price) return parseFloat(product.price);

  // Extract from snippet using regex
  const text = `${item.title} ${item.snippet || ''}`;
  const priceMatch = text.match(/\$(\d{1,4}(?:\.\d{2})?)/);
  if (priceMatch) return parseFloat(priceMatch[1]);

  return 0;
}

function extractRating(item) {
  const agg = item.pagemap?.aggregaterating?.[0];
  if (agg?.ratingvalue) return parseFloat(agg.ratingvalue);

  const product = item.pagemap?.product?.[0];
  if (product?.ratingvalue) return parseFloat(product.ratingvalue);

  return 0;
}

function extractPartName(item, fallback) {
  const product = item.pagemap?.product?.[0];
  if (product?.name) return product.name.substring(0, 80);
  // Use title but trim it
  return item.title?.substring(0, 60) || fallback;
}

function estimateDelivery(item) {
  const text = `${item.snippet || ''} ${item.title}`;
  if (/same.?day|next.?day|1.?day/i.test(text)) return 1;
  if (/2.?day|two.?day/i.test(text)) return 2;
  if (/free.?shipping/i.test(text)) return 3;
  return 5; // default estimate
}

// ── Health check ──
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    googleApiConfigured: !!(GOOGLE_API_KEY && GOOGLE_CSE_ID),
    cacheSize: cache.size,
  });
});

app.listen(PORT, () => {
  console.log(`\n  Vendor search API running on http://localhost:${PORT}`);
  console.log(`  Health check: http://localhost:${PORT}/api/health`);
  if (!GOOGLE_API_KEY || !GOOGLE_CSE_ID) {
    console.log('\n  ⚠ Google API not configured — will return fallback estimates');
    console.log('  Set GOOGLE_API_KEY and GOOGLE_CSE_ID env vars to enable real search\n');
  }
});
