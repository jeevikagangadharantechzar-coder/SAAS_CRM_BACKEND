import { getEmailFromQueue } from "../utils/emailQueue.js";
import sendEmail from "../utils/sendEmail.js";

const processQueue = async () => {
  while (true) {
    try {
      const job = await getEmailFromQueue();

      if (job) {
        console.log(" Sending email to:", job.to);

        await sendEmail({
          to: job.to,
          subject: job.subject,
          html: job.html,
          attachments: job.attachments,
        });

        console.log(" Email sent:", job.to);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      } else {
        // No job in queue → wait a bit
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } catch (err) {
      console.error(" Worker error:", err);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
};

processQueue();
