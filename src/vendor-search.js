/*
 * vendor-search.js — Vendor search for replacement parts
 *
 * For glass_shatter, tire_flat, lamp_broken:
 * Searches online vendors for replacement parts, returns top 3
 * sorted by price (cheapest first), with reliability ratings.
 *
 * Architecture:
 *   1. Check in-memory cache (avoid re-scraping within session)
 *   2. Call scraping backend / aggregator API
 *   3. Fallback to market-average estimates if fetch fails
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │  INTEGRATION POINT                                         │
 * │                                                            │
 * │  Replace SCRAPING_ENDPOINT with your backend URL.          │
 * │  The backend should accept POST { damageType, vehicle }    │
 * │  and return { vendors: [...] }.                            │
 * │                                                            │
 * │  Recommended backend targets:                              │
 * │  - RockAuto (parts catalog, wide coverage)                 │
 * │  - AutoZone / O'Reilly (stock + local availability)       │
 * │  - Amazon Product Advertising API                          │
 * │  - Google Shopping API                                     │
 * │  - eBay Motors API                                         │
 * └─────────────────────────────────────────────────────────────┘
 */

const SCRAPING_ENDPOINT = null; // e.g. "https://your-api.com/vendors"

const PART_KEYWORDS = {
  glass_shatter: {
    searchTerm: "car windshield replacement glass",
    partName: "Windshield / Window Glass",
    fallbackMin: 150,
    fallbackMax: 400,
  },
  tire_flat: {
    searchTerm: "car tire replacement",
    partName: "Tire Replacement",
    fallbackMin: 60,
    fallbackMax: 200,
  },
  lamp_broken: {
    searchTerm: "car headlight lamp assembly",
    partName: "Headlight / Lamp Assembly",
    fallbackMin: 40,
    fallbackMax: 250,
  },
};

const CURRENCY = "USD";

/* in-memory session cache: avoids re-scraping the same part */
const vendorCache = new Map();

export async function searchVendors(damageType, vehicleInfo = null) {
  const partInfo = PART_KEYWORDS[damageType];
  if (!partInfo) {
    return { vendors: [], fallbackEstimate: null };
  }

  /* cache key includes vehicle info for specificity */
  const cacheKey = `${damageType}|${vehicleInfo?.make || ""}|${vehicleInfo?.model || ""}|${vehicleInfo?.year || ""}`;
  if (vendorCache.has(cacheKey)) {
    return vendorCache.get(cacheKey);
  }

  try {
    const vendors = await fetchVendorResults(partInfo, vehicleInfo);

    if (vendors.length === 0) {
      const result = {
        vendors: [],
        fallbackEstimate: {
          min: partInfo.fallbackMin,
          max: partInfo.fallbackMax,
          currency: CURRENCY,
          partName: partInfo.partName,
          note: "No online vendor found — estimate based on market averages",
        },
      };
      vendorCache.set(cacheKey, result);
      return result;
    }

    /* sort by price, take top 3 */
    vendors.sort((a, b) => a.price - b.price);
    const top3 = vendors.slice(0, 3);

    const result = { vendors: top3, fallbackEstimate: null };
    vendorCache.set(cacheKey, result);
    return result;
  } catch (error) {
    console.error(`Vendor search failed for ${damageType}:`, error);

    const result = {
      vendors: [],
      fallbackEstimate: {
        min: partInfo.fallbackMin,
        max: partInfo.fallbackMax,
        currency: CURRENCY,
        partName: partInfo.partName,
        note: "Vendor search failed — estimate based on market averages",
      },
    };
    /* don't cache errors — retry next time */
    return result;
  }
}

/*
 * Fetch vendor results with retry.
 * If SCRAPING_ENDPOINT is configured, calls the real backend.
 * Otherwise falls back to mock data for development.
 */
async function fetchVendorResults(partInfo, vehicleInfo, retries = 2) {
  if (SCRAPING_ENDPOINT) {
    return fetchFromBackend(partInfo, vehicleInfo, retries);
  }
  return fetchMockResults(partInfo, vehicleInfo);
}

async function fetchFromBackend(partInfo, vehicleInfo, retries) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const resp = await fetch(SCRAPING_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          searchTerm: partInfo.searchTerm,
          partName: partInfo.partName,
          vehicle: vehicleInfo,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!resp.ok) {
        throw new Error(`Backend returned ${resp.status}`);
      }

      const data = await resp.json();

      /* validate vendor shape */
      if (!Array.isArray(data.vendors)) {
        throw new Error("Invalid response shape");
      }

      return data.vendors.filter(validateVendor);
    } catch (err) {
      console.warn(
        `Vendor fetch attempt ${attempt + 1} failed:`,
        err.message,
      );
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }

  return [];
}

function validateVendor(v) {
  return (
    typeof v.name === "string" &&
    typeof v.price === "number" &&
    v.price > 0 &&
    typeof v.partName === "string"
  );
}

/*
 * Mock vendor data for development / offline use.
 * Returns realistic results after a simulated delay.
 */
async function fetchMockResults(partInfo) {
  await new Promise((r) => setTimeout(r, 400));

  const mockVendors = {
    glass_shatter: [
      {
        name: "AutoGlass Direct",
        price: 189.99,
        currency: CURRENCY,
        url: "https://example.com/autoglass",
        rating: 4.6,
        inStock: true,
        partName: "OEM Windshield Glass",
        deliveryDays: 3,
      },
      {
        name: "Safelite",
        price: 249.0,
        currency: CURRENCY,
        url: "https://example.com/safelite",
        rating: 4.8,
        inStock: true,
        partName: "Certified Windshield Replacement",
        deliveryDays: 1,
      },
      {
        name: "GlassMart",
        price: 159.5,
        currency: CURRENCY,
        url: "https://example.com/glassmart",
        rating: 4.2,
        inStock: true,
        partName: "Aftermarket Windshield",
        deliveryDays: 5,
      },
    ],
    tire_flat: [
      {
        name: "TireRack",
        price: 89.99,
        currency: CURRENCY,
        url: "https://example.com/tirerack",
        rating: 4.7,
        inStock: true,
        partName: "All-Season Tire 205/55R16",
        deliveryDays: 2,
      },
      {
        name: "Discount Tire",
        price: 75.0,
        currency: CURRENCY,
        url: "https://example.com/discounttire",
        rating: 4.5,
        inStock: true,
        partName: "Economy Tire 205/55R16",
        deliveryDays: 3,
      },
      {
        name: "Walmart Auto",
        price: 68.5,
        currency: CURRENCY,
        url: "https://example.com/walmart",
        rating: 4.0,
        inStock: true,
        partName: "Budget Tire 205/55R16",
        deliveryDays: 5,
      },
    ],
    lamp_broken: [
      {
        name: "RockAuto",
        price: 45.99,
        currency: CURRENCY,
        url: "https://example.com/rockauto",
        rating: 4.4,
        inStock: true,
        partName: "Aftermarket Headlight Assembly",
        deliveryDays: 4,
      },
      {
        name: "AutoZone",
        price: 79.99,
        currency: CURRENCY,
        url: "https://example.com/autozone",
        rating: 4.6,
        inStock: true,
        partName: "OEM-Spec Headlight Assembly",
        deliveryDays: 2,
      },
      {
        name: "Amazon Auto",
        price: 55.0,
        currency: CURRENCY,
        url: "https://example.com/amazon",
        rating: 4.3,
        inStock: true,
        partName: "Replacement Headlight Unit",
        deliveryDays: 2,
      },
    ],
  };

  const key = partInfo.searchTerm.includes("windshield")
    ? "glass_shatter"
    : partInfo.searchTerm.includes("tire")
      ? "tire_flat"
      : "lamp_broken";

  return mockVendors[key] || [];
}
