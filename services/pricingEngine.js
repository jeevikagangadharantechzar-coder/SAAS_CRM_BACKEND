import Deal from "../models/deals.model.js";

class PricingEngine {
  // Calculate average deal value by industry and company size
  static async getIndustryAverage(industry, companySize) {
    const query = { stage: "Closed Won" };
    if (industry) query.industry = industry;
    if (companySize) query.companySize = companySize;

    const deals = await Deal.find(query).lean();
    
    if (deals.length === 0) return null;

    let totalValue = 0;
    let totalDiscount = 0;
    let discountCount = 0;

    deals.forEach(deal => {
      if (deal.value) {
        const value = parseFloat(deal.value.toString().replace(/[^0-9.-]+/g, '')) || 0;
        totalValue += value;
      }
      if (deal.discountGiven) {
        totalDiscount += deal.discountGiven;
        discountCount++;
      }
    });

    const avgValue = totalValue / deals.length;
    const avgDiscount = discountCount > 0 ? totalDiscount / discountCount : 0;

    return {
      avgValue,
      avgDiscount,
      dealCount: deals.length
    };
  }

  // Calculate win rate by price range
  static async getWinRateByPriceRange(industry) {
    const query = { industry };
    const deals = await Deal.find(query).lean();

    const priceRanges = {
      low: { min: 0, max: 50000, wins: 0, total: 0 },
      medium: { min: 50001, max: 200000, wins: 0, total: 0 },
      high: { min: 200001, max: 500000, wins: 0, total: 0 },
      enterprise: { min: 500001, max: Infinity, wins: 0, total: 0 }
    };

    deals.forEach(deal => {
      const value = parseFloat(deal.value?.toString().replace(/[^0-9.-]+/g, '')) || 0;
      let range;
      
      if (value <= 50000) range = priceRanges.low;
      else if (value <= 200000) range = priceRanges.medium;
      else if (value <= 500000) range = priceRanges.high;
      else range = priceRanges.enterprise;

      range.total++;
      if (deal.stage === "Closed Won") range.wins++;
    });

    // Calculate win rates
    const winRates = {};
    Object.keys(priceRanges).forEach(key => {
      const range = priceRanges[key];
      winRates[key] = range.total > 0 ? (range.wins / range.total) * 100 : 0;
    });

    return winRates;
  }

  // Suggest price for a deal
  static async suggestPrice(companyId, dealValue, industry, companySize) {
    try {
      // Get historical data for this industry
      const industryAvg = await this.getIndustryAverage(industry, companySize);
      
      if (!industryAvg) {
        return {
          suggestedMinPrice: dealValue * 0.9,
          suggestedMaxPrice: dealValue * 1.1,
          recommendedDiscount: 10,
          riskLevel: "Medium",
          confidenceScore: 30,
          message: "Limited historical data, using default ranges"
        };
      }

      // Get win rates by price range
      const winRates = await this.getWinRateByPriceRange(industry);

      // Calculate optimal price range
      const optimalPrice = industryAvg.avgValue;
      const suggestedMin = optimalPrice * 0.9;
      const suggestedMax = optimalPrice * 1.2;

      // Calculate safe discount (slightly above average)
      const safeDiscount = Math.min(industryAvg.avgDiscount * 1.1, 25); // Cap at 25%

      // Determine risk level
      let riskLevel = "Low";
      let confidenceScore = 70;

      const currentPrice = parseFloat(dealValue?.toString().replace(/[^0-9.-]+/g, '')) || 0;
      
      if (currentPrice < suggestedMin * 0.8) {
        riskLevel = "High";
        confidenceScore = 40;
      } else if (currentPrice > suggestedMax * 1.3) {
        riskLevel = "High";
        confidenceScore = 35;
      } else if (currentPrice < suggestedMin || currentPrice > suggestedMax) {
        riskLevel = "Medium";
        confidenceScore = 55;
      }

      // Adjust confidence based on data volume
      if (industryAvg.dealCount < 10) {
        confidenceScore = Math.max(30, confidenceScore - 20);
      }

      return {
        suggestedMinPrice: Math.round(suggestedMin),
        suggestedMaxPrice: Math.round(suggestedMax),
        recommendedDiscount: Math.round(safeDiscount),
        riskLevel,
        confidenceScore,
        industryAverage: Math.round(industryAvg.avgValue),
        averageDiscount: Math.round(industryAvg.avgDiscount),
        winRates
      };
    } catch (error) {
      console.error("Error in pricing engine:", error);
      throw error;
    }
  }

  // Check for pricing risk in a deal
  static async checkPricingRisk(deal) {
    const value = parseFloat(deal.value?.toString().replace(/[^0-9.-]+/g, '')) || 0;
    const discount = deal.discountGiven || 0;
    
    const industryAvg = await this.getIndustryAverage(deal.industry, deal.companySize);
    
    if (!industryAvg) return null;

    const risks = [];
    
    // Check if price is too low
    if (value < industryAvg.avgValue * 0.7) {
      risks.push("Price significantly below industry average");
    }
    
    // Check if discount is too high
    if (discount > industryAvg.avgDiscount * 1.5) {
      risks.push("Discount much higher than usual");
    }
    
    // Check if price is too high
    if (value > industryAvg.avgValue * 1.5) {
      risks.push("Price significantly above industry average");
    }

    return {
      hasRisk: risks.length > 0,
      risks,
      riskLevel: risks.length > 2 ? "High" : risks.length > 0 ? "Medium" : "Low"
    };
  }
}

export default PricingEngine;