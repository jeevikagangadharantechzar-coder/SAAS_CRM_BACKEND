import dotenv from "dotenv";
import connectDB from "../config/db.js";
import EmailTemplate from "../models/emailTemplate.model.js";
import templates from "./data/defaultEmailTemplates.js";

dotenv.config();

const seedTemplates = async () => {
  try {
    await connectDB(); 

    const existing = await EmailTemplate.countDocuments();

    if (existing > 0) {
      console.log(" Templates already exist. Skipping insert.");
      process.exit(0);
    }

    await EmailTemplate.insertMany(templates);

    console.log(" Templates seeded successfully");
    process.exit(0);
  } catch (error) {
    console.error(" Error seeding templates:", error);
    process.exit(1);
  }
};

seedTemplates();
