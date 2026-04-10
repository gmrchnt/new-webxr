/*
 * vendor-search.js — Client-side vendor search module
 *
 * Calls /api/vendors on the Express backend which proxies
 * to Google Custom Search API for real product listings.
 *
 * For glass_shatter, tire_flat, lamp_broken:
 *   Returns top 3 vendors sorted by price, with fallback estimates.
 */

const CURRENCY = "USD";

/* Session cache to avoid re-fetching */
const vendorCache = new Map();

export async function searchVendors(damageType, vehicleInfo = null) {
  const cacheKey = `${damageType}|${vehicleInfo?.make || ""}|${vehicleInfo?.model || ""}|${vehicleInfo?.year || ""}`;

  if (vendorCache.has(cacheKey)) {
    return vendorCache.get(cacheKey);
  }

  try {
    const resp = await fetch('/api/vendors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ damageType, vehicle: vehicleInfo }),
    });

    if (!resp.ok) throw new Error(`Server returned ${resp.status}`);

    const result = await resp.json();
    vendorCache.set(cacheKey, result);
    return result;
  } catch (error) {
    console.error(`Vendor search failed for ${damageType}:`, error);

    // Fallback estimates if backend is unreachable
    const fallbacks = {
      glass_shatter: { min: 150, max: 400, partName: 'Windshield / Window Glass' },
      tire_flat:     { min: 60,  max: 200, partName: 'Tire Replacement' },
      lamp_broken:   { min: 40,  max: 250, partName: 'Headlight / Lamp Assembly' },
    };

    const fb = fallbacks[damageType];
    if (!fb) return { vendors: [], fallbackEstimate: null };

    return {
      vendors: [],
      fallbackEstimate: {
        min: fb.min,
        max: fb.max,
        currency: CURRENCY,
        partName: fb.partName,
        note: `Backend unreachable — showing market average estimates`,
      },
    };
  }
}
