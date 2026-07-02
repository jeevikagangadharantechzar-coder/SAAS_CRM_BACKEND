import nodemailer from "nodemailer";
import crypto from "crypto"; 

const sendEmail = async ({ to, subject, html, attachments = [] }) => {
  const transporter = nodemailer.createTransport({
    service: "Gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    tls: {
      rejectUnauthorized: false,
    },
  });

  console.log(`Sending email to: ${to}, subject: ${subject}`);
  await transporter.sendMail({
    from: `"TZI Support" <${process.env.EMAIL_USER}>`,
    to,
    subject,
    html,
    attachments,
  });
  console.log(`Email sent successfully to: ${to}`);
};

export default sendEmail;