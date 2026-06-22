import nodemailer from "nodemailer";
import dotenv from "dotenv";
dotenv.config();

const sendEmail = async ({ to, subject, text, html }) => {
  if (!to) return;
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail", 
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    const info = await transporter.sendMail({
      from: `"CRM" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      text,
      html: html || `<p>${text || ""}</p>`,
    });

    console.log(" Email sent:", info.messageId);
  } catch (err) {
    console.error(" Email error:", err.message);
  }
};

export default sendEmail;
