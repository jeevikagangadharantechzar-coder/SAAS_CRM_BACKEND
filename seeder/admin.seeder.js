import dotenv from "dotenv";
import connectDB from "../config/db.js";
import Role from "../models/role.model.js";
import User from "../models/user.model.js";

dotenv.config();

const seedAdmin = async () => {
  try {
    await connectDB();

    // 1) Ensure Admin role exists
    let adminRole = await Role.findOne({ name: "Admin" });
    if (!adminRole) {
      adminRole = await Role.create({ name: "Admin" });
      console.log(" Admin role created");
    } else {
      console.log(" Admin role already exists");
    }

    // 2) Upsert admin user with plain password (let pre-save hook hash it)
    const email = "admin@gmail.com";
    let admin = await User.findOne({ email });

    if (admin) {
      // Reset password to plain so pre-save re-hashes correctly
      admin.firstName = "Super";
      admin.lastName = "Admin";
      admin.role = adminRole._id;
      admin.dateOfBirth = new Date("2000-01-01");
      admin.password = "Techzar@123"; // PLAIN — pre-save will hash
            admin.status = "Active";
      await admin.save();          // triggers pre-save hook
      console.log(" Admin user password reset and updated");
    } else {
      await User.create({
        firstName: "Super",
        lastName: "Admin",
        email,
        password: "Techzar@123", // PLAIN — pre-save will hash
        role: adminRole._id,
        dateOfBirth: new Date("2000-01-01"),
      });
      console.log(" Admin user created");
    }

    process.exit(0);
  } catch (error) {
    console.error(" Error seeding admin:", error);
    process.exit(1);
  }
};

seedAdmin();





