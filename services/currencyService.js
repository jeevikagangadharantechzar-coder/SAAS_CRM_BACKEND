import axios from "axios";

// In-memory cache for exchange rates (TTL: 1 hour)
let ratesCache = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Fetch latest rates based on USD
 */
const fetchRates = async () => {
  const now = Date.now();
  if (ratesCache && now - lastFetchTime < CACHE_TTL_MS) {
    return ratesCache;
  }

  try {
    const res = await axios.get("https://open.er-api.com/v6/latest/USD");
    if (res.data?.rates) {
      ratesCache = res.data.rates;
      lastFetchTime = now;
      return ratesCache;
    }
  } catch (err) {
    console.error("Currency API fetch error:", err.message);
  }

  // Fallback defaults if offline / network error
  return {
    USD: 1,
    INR: 86.5,
    EUR: 0.92,
    GBP: 0.79,
    AED: 3.67,
    CAD: 1.36,
    AUD: 1.52,
    SGD: 1.34,
  };
};

/**
 * Get conversion rate from any currency to any currency
 * e.g., getConversionRate("INR", "USD") => 0.01156
 */
export const getConversionRate = async (from = "INR", to = "USD") => {
  if (from === to) return 1;

  const rates = await fetchRates();
  const fromRateInUSD = rates[from] || 1;
  const toRateInUSD = rates[to] || 1;

  // Since all rates are relative to USD: (1 / fromRate) * toRate
  const rate = toRateInUSD / fromRateInUSD;
  return Number(rate.toFixed(6));
};

export const getExchangeRate = async (fromCurrency) => {
  return await getConversionRate(fromCurrency, "INR");
};