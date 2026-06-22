import axios from "axios";

export const getExchangeRate = async (fromCurrency) => {
  try {
    if (fromCurrency === "INR") return 1;

    const res = await axios.get(
      `https://open.er-api.com/v6/latest/${fromCurrency}`
    );

    const rate = res.data?.rates?.INR;

    return rate || 1;
  } catch (err) {
    console.error("Exchange rate error:", err.message);
    return 1;
  }
};