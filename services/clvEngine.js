import Deal from "../models/deals.model.js";
import SupportTicket from "../models/SupportTicket.js";
import ClientReview from "../models/ClientReview.js";
import Renewal from "../models/Renewal.js";
import ClientLTV from "../models/ClientLTV.js";
import PricingRisk from "../models/PricingRisk.js";

class CLVEngine {
  // Calculate all metrics for a client
  static async calculateClientMetrics(companyId, companyName) {
    try {
      // 1. Get all closed won deals for this company
      const deals = await Deal.find({ 
        companyName, 
        stage: "Closed Won" 
      }).sort({ wonAt: -1 }).lean();
      
      if (!deals.length) return null;

      // 2. Get support tickets
      const tickets = await SupportTicket.find({ companyId }).lean();
      
      // 3. Get latest review
      const latestReview = await ClientReview.findOne({ companyId })
        .sort({ reviewedAt: -1 })
        .lean();

      // 4. Get renewals
      const renewals = await Renewal.find({ 
        companyName,
        status: { $in: ["Completed", "Approved"] }
      }).lean();

      // Calculate metrics
      const totalRevenue = deals.reduce((sum, deal) => {
        const value = parseFloat(deal.value?.toString().replace(/[^0-9.-]+/g, '')) || 0;
        return sum + value;
      }, 0);

      const totalDeals = deals.length;
      const avgDealValue = totalDeals > 0 ? totalRevenue / totalDeals : 0;
      
      // Repeat purchase rate
      const repeatRate = totalDeals > 1 ? ((totalDeals - 1) / totalDeals) * 100 : 0;

      // Days since last follow-up
      const lastFollowUpDeal = await Deal.findOne({ 
        companyName,
        followUpDate: { $ne: null }
      }).sort({ followUpDate: -1 }).lean();
      
      const lastFollowUpDate = lastFollowUpDeal?.followUpDate || null;
      const daysSinceFollowUp = lastFollowUpDate
        ? Math.floor((Date.now() - new Date(lastFollowUpDate)) / (1000 * 60 * 60 * 24))
        : 365;

      // Support metrics
      const totalSupportTickets = tickets.length;
      const openSupportTickets = tickets.filter(t => t.status === "Open").length;
      const lastSupportDate = tickets.length > 0 ? tickets[0].openedAt : null;

      // Classification logic
      let classification = "Active";
      let upsellOpportunity = latestReview?.upsellOpportunity || false;
      let positiveReply = latestReview?.positiveReply || false;
      let clientHealthScore = latestReview?.clientHealthScore || 50;

      if (daysSinceFollowUp > 90) {
        classification = "Dormant";
      } else if (totalSupportTickets > 10 || daysSinceFollowUp > 60) {
        classification = "Risky";
      } else if (upsellOpportunity) {
        classification = "Upsell Opportunity";
      } else if (totalRevenue > 50000 && totalSupportTickets < 3 && daysSinceFollowUp < 60) {
        classification = "High Value";
      }

      // Risk score calculation
      let riskScore = 0;
      const riskFactors = [];

      if (daysSinceFollowUp > 90) {
        riskScore += 50;
        riskFactors.push("No follow-up for over 90 days");
      } else if (daysSinceFollowUp > 60) {
        riskScore += 30;
        riskFactors.push("No follow-up for over 60 days");
      }

      if (totalSupportTickets > 10) {
        riskScore += 30;
        riskFactors.push("High support volume");
      } else if (totalSupportTickets > 5) {
        riskScore += 15;
        riskFactors.push("Moderate support volume");
      }

      riskScore = Math.min(riskScore, 100);

      // CLV calculation
      const customerLifetimeValue = totalRevenue * (1 + repeatRate / 100);
      const projectedCLV = customerLifetimeValue * 1.2;

      // Update or create ClientLTV
      let clientLTV = await ClientLTV.findOne({ companyId });
      
      if (!clientLTV) {
        clientLTV = new ClientLTV({
          companyId,
          companyName,
        });
      }

      // Update all fields
      clientLTV.totalRevenue = totalRevenue;
      clientLTV.averageDealValue = avgDealValue;
      clientLTV.totalDeals = totalDeals;
      clientLTV.closedWonDeals = totalDeals;
      clientLTV.repeatPurchaseRate = repeatRate;
      clientLTV.firstDealDate = deals[deals.length - 1]?.wonAt;
      clientLTV.lastDealDate = deals[0]?.wonAt;
      clientLTV.lastFollowUpDate = lastFollowUpDate;
      clientLTV.daysSinceFollowUp = daysSinceFollowUp;
      clientLTV.lastActivityDate = lastFollowUpDate || deals[0]?.wonAt;
      
      clientLTV.totalSupportTickets = totalSupportTickets;
      clientLTV.openSupportTickets = openSupportTickets;
      clientLTV.lastSupportDate = lastSupportDate;
      
      clientLTV.riskScore = riskScore;
      clientLTV.riskFactors = riskFactors;
      clientLTV.classification = classification;
      clientLTV.customerLifetimeValue = customerLifetimeValue;
      clientLTV.projectedCLV = projectedCLV;
      
      clientLTV.clientHealthScore = clientHealthScore;
      clientLTV.upsellOpportunity = upsellOpportunity;
      clientLTV.positiveReply = positiveReply;
      
      if (latestReview) {
        clientLTV.latestReview = latestReview._id;
      }

      await clientLTV.save();
      
      // Trigger pricing risk analysis
      await this.analyzePricingRisk(companyId, companyName, deals[0]);

      return clientLTV;
    } catch (error) {
      console.error("Error in calculateClientMetrics:", error);
      throw error;
    }
  }

  // Analyze pricing risk for a deal
  static async analyzePricingRisk(companyId, companyName, latestDeal) {
    try {
      if (!latestDeal) return;

      const dealValue = parseFloat(latestDeal.value?.toString().replace(/[^0-9.-]+/g, '')) || 0;
      const discountGiven = latestDeal.discountGiven || 0;
      
      // Get industry average
      const industryDeals = await Deal.find({ 
        industry: latestDeal.industry,
        stage: "Closed Won"
      }).lean();

      let avgDealValue = 0;
      if (industryDeals.length > 0) {
        const total = industryDeals.reduce((sum, d) => {
          const val = parseFloat(d.value?.toString().replace(/[^0-9.-]+/g, '')) || 0;
          return sum + val;
        }, 0);
        avgDealValue = total / industryDeals.length;
      }

      const riskFactors = [];
      let riskLevel = "Low";
      let recommendedDiscount = 0;

      // Rule 1: High discount
      if (discountGiven > 20) {
        riskLevel = "High";
        riskFactors.push(`Discount ${discountGiven}% exceeds 20% threshold`);
      }

      // Rule 2: Price too low
      if (avgDealValue > 0 && dealValue < avgDealValue * 0.7) {
        riskLevel = riskLevel === "High" ? "High" : "Medium";
        riskFactors.push(`Price ${dealValue} is 70% below industry average ${avgDealValue}`);
      }

      // Get client quality for discount recommendation
      const clientLTV = await ClientLTV.findOne({ companyId });
      const latestReview = await ClientReview.findOne({ companyId })
        .sort({ reviewedAt: -1 })
        .lean();

      // Dynamic pricing recommendation
      if (latestReview) {
        const { progress, supportTickets, positiveReply } = latestReview;
        
        if (progress === "Excellent" && supportTickets < 3 && positiveReply && dealValue > 500000) {
          recommendedDiscount = 15;
        } else if (progress === "Good" || progress === "Average") {
          recommendedDiscount = 7;
        } else {
          recommendedDiscount = 0;
        }
      }

      // Check if sales rep gives too many discounts
      const repDeals = await Deal.find({ 
        assignedTo: latestDeal.assignedTo,
        discountGiven: { $gt: 0 }
      }).lean();

      if (repDeals.length > 5) {
        const avgRepDiscount = repDeals.reduce((sum, d) => sum + (d.discountGiven || 0), 0) / repDeals.length;
        if (avgRepDiscount > 15) {
          riskFactors.push(`Sales rep average discount ${avgRepDiscount.toFixed(1)}% is high`);
        }
      }

      // Update or create pricing risk
      await PricingRisk.findOneAndUpdate(
        { dealId: latestDeal._id },
        {
          dealId: latestDeal._id,
          companyId,
          companyName,
          dealName: latestDeal.dealName,
          dealValue,
          discountGiven,
          salespersonId: latestDeal.assignedTo,
          salespersonName: latestDeal.assignedTo?.name,
          riskLevel,
          riskFactors,
          recommendedDiscount,
          clientProgress: latestReview?.progress,
          supportTickets: latestReview?.supportTickets,
          positiveReply: latestReview?.positiveReply,
          status: "Active"
        },
        { upsert: true, new: true }
      );

    } catch (error) {
      console.error("Error in analyzePricingRisk:", error);
    }
  }

  // Get revenue trends for dashboard
  static async getRevenueTrends(months = 6) {
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - months);

    const revenueData = await Deal.aggregate([
      {
        $match: { 
          stage: "Closed Won",
          wonAt: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: "$wonAt" },
            month: { $month: "$wonAt" }
          },
          revenue: { 
            $sum: { 
              $toDouble: {
                $reduce: {
                  input: { $regexFindAll: { input: "$value", regex: /[0-9]+/ } },
                  initialValue: "",
                  in: { $concat: ["$$value", "$$this.match"] }
                }
              }
            }
          }
        }
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } }
    ]);

    // Format for chart
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    
    return revenueData.map(item => ({
      month: `${monthNames[item._id.month - 1]} ${item._id.year}`,
      revenue: item.revenue || 0
    }));
  }

  // Get dashboard summary
  static async getDashboardSummary() {
    const clients = await ClientLTV.find().lean();
    
    const summary = {
      totalClients: clients.length,
      totalCLV: clients.reduce((sum, c) => sum + (c.customerLifetimeValue || 0), 0),
      avgCLV: 0,
      avgRiskScore: 0,
      highValueCount: 0,
      riskyCount: 0,
      dormantCount: 0,
      upsellCount: 0,
    };

    summary.avgCLV = summary.totalClients > 0 ? summary.totalCLV / summary.totalClients : 0;

    clients.forEach(c => {
      if (c.classification === "High Value") summary.highValueCount++;
      if (c.classification === "Risky") summary.riskyCount++;
      if (c.classification === "Dormant") summary.dormantCount++;
      if (c.upsellOpportunity) summary.upsellCount++;
      summary.avgRiskScore += c.riskScore || 0;
    });

    summary.avgRiskScore = summary.totalClients > 0 
      ? Math.round(summary.avgRiskScore / summary.totalClients) 
      : 0;

    return summary;
  }
}

export default CLVEngine;