import cron from "node-cron";
import Proposal from "../models/proposal.model.js";
import Deal from "../models/deals.model.js";
import User from "../models/user.model.js";
import Role from "../models/role.model.js";
import moment from "moment";
import { sendNotification } from "../services/notificationService.js";

const REMIND_GAP_MINUTES = 120;

export default {

  // Get all admin user IDs
  async getAdminUserIds() {
    const adminRole = await Role.findOne({ name: "Admin" });
    if (!adminRole) return [];

    const admins = await User.find({ role: adminRole._id }, "_id");
    return admins.map((a) => a._id.toString());
  },

  // Start proposal follow-up cron
  startProposalFollowUpCron() {
    cron.schedule("* * * * *", async () => {

      const nowUtc = moment.utc();
      console.log(
        " Proposal Follow-up Cron Running:",
        nowUtc.format("YYYY-MM-DD HH:mm:ss")
      );

      try {

        const dueProposals = await Proposal.find({
          followUpDate: { $lte: nowUtc.toDate() },
          $or: [
            { lastReminderAt: { $exists: false } },
            { lastReminderAt: null },
            {
              lastReminderAt: {
                $lt: nowUtc
                  .clone()
                  .subtract(REMIND_GAP_MINUTES, "minute")
                  .toDate(),
              },
            },
          ],
        }).populate({
          path: "deal",
          populate: {
            path: "assignedTo",
            select: "firstName lastName email profileImage",
          },
        });

        if (!dueProposals.length) {
          console.log(" No due proposals found");
          return;
        }

        console.log(` Found ${dueProposals.length} due proposals`);

        const admins = await this.getAdminUserIds();

        for (const proposal of dueProposals) {

          let assignedUserId = null;
          let salesmanName = "Unknown";
          let profileImage = null;

          if (proposal.deal && proposal.deal.assignedTo) {
            assignedUserId = proposal.deal.assignedTo._id.toString();

            salesmanName = `${proposal.deal.assignedTo.firstName || ""} ${
              proposal.deal.assignedTo.lastName || ""
            }`.trim();

            profileImage = proposal.deal.assignedTo.profileImage;
          }

          console.log(
            `Processing proposal: ${proposal.title}, Assigned to: ${salesmanName}`
          );

          // Send notification to salesperson
          if (assignedUserId) {
            await sendNotification(
              assignedUserId,
              `Follow-up due for proposal: ${proposal.title}`,
              "followup",
              {
                proposalId: proposal._id.toString(),
                proposalTitle: proposal.title,
                dealId: proposal.deal?._id,
                salesmanName: salesmanName,
                profileImage: profileImage,
              }
            );
          }

          // Send notification to admins
          for (const adminId of admins) {
            await sendNotification(
              adminId,
              `Proposal follow-up due: ${proposal.title} (Assigned to: ${salesmanName})`,
              "admin",
              {
                proposalId: proposal._id.toString(),
                proposalTitle: proposal.title,
                salesmanName: salesmanName,
                salesmanId: assignedUserId,
              }
            );
          }

          //  Use findByIdAndUpdate to skip validation
          //  only the lastReminderAt field without triggering full document validation
          await Proposal.findByIdAndUpdate(
            proposal._id,
            { 
              $set: { 
                lastReminderAt: new Date() 
              } 
            },
            { 
              runValidators: false,  // Skip validation to avoid attachment errors
              new: true 
            }
          );

          console.log(
            ` Updated lastReminderAt for proposal: ${proposal.title}`
          );
        }

      } catch (err) {
        console.error(" Proposal follow-up cron error:", err);
      }
    });
  },
};