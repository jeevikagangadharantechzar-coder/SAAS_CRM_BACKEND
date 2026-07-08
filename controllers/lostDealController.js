import { getTenantModels } from "../models/tenant/index.js";
import LostDealReasonLegacy from "../models/lostDealReasonModel.js";
import DealLegacy from "../models/deals.model.js";

const getModels = (req) =>
  req.tenantDB
    ? getTenantModels(req.tenantDB)
    : { Deal: DealLegacy, LostDealReason: LostDealReasonLegacy };

export default{
// save the reason for the deal lost
saveLostDealReason : async (req, res) => {
  try {
    const { Deal, LostDealReason } = getModels(req);
    const { dealId, reason, notes } = req.body;
    const userId = req.user?._id || null;

    console.log(" Saving lost deal reason:", {
      dealId,
      reason,
      notes,
      userId,
    });

    // Validation
    if (!dealId) {
      return res.status(400).json({
        success: false,
        message: "Deal ID is required",
      });
    }

    if (!reason || reason.trim() === "") {
      return res.status(400).json({
        success: false,
        message: "Loss reason is required",
      });
    }

    // Check if deal exists
    const deal = await Deal.findById(dealId);
    if (!deal) {
      return res.status(404).json({
        success: false,
        message: "Deal not found",
      });
    }

    // Create lost reason record
    const lostReason = await LostDealReason.create({
      dealId,
      reason,
      notes: notes || "",
      createdBy: userId,
    });

//  mark as closed lost
const updateData = {
  stage: "Closed Lost",
  lossReason: reason,
  lossNotes: notes || "",
  updatedAt: new Date()
};

if (deal.stage !== "Closed Lost") {
  updateData.stageLostAt = deal.stage;
  updateData.lostDate = new Date();
}

const updatedDeal = await Deal.findByIdAndUpdate(dealId, updateData, { new: true, runValidators: false });

    return res.status(200).json({
      success: true,
      message: "Deal marked as Closed Lost successfully",
      data: {
        lostReason,
        deal: {
          _id: updatedDeal._id,
          dealName: updatedDeal.dealName,
          stage: updatedDeal.stage,
          lossReason: updatedDeal.lossReason,
          lossNotes: updatedDeal.lossNotes,
        },
      },
    });
  } catch (error) {
    console.error(" Lost reason error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while saving lost deal",
      error: error.message,
      stack: error.stack
    });
  }
},
// get the lost deal reasons
getLostDealReasons :async (req, res) => {
  try {
    const { LostDealReason } = getModels(req);
    const lostReasons = await LostDealReason.find()
      .populate("dealId", "dealName stage value")
      .populate("createdBy", "firstName lastName email")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      data: lostReasons,
    });
  } catch (error) {
    console.error("Error fetching lost deal reasons:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
}
};