import bcrypt from "bcryptjs";
import crypto from "crypto";

class UserService {
  /**
   * Hashes a plain text password.
   * @param {string} password - The plain text password.
   * @returns {Promise<string>} - The hashed password.
   */
  async hashPassword(password) {
    const salt = await bcrypt.genSalt(10);
    return await bcrypt.hash(password, salt);
  }

  /**
   * Compares a plain text password with a hashed password.
   * @param {string} enteredPassword - The plain text password.
   * @param {string} userPassword - The hashed password from the database.
   * @returns {Promise<boolean>} - True if they match, false otherwise.
   */
  async matchPassword(enteredPassword, userPassword) {
    return await bcrypt.compare(enteredPassword, userPassword);
  }

  /**
   * Generates a reset password token and its hashed version for the database.
   * @returns {Object} - An object containing the raw resetToken, hashedToken, and expireDate.
   */
  generateResetPasswordToken() {
    const resetToken = crypto.randomBytes(32).toString("hex");

    const hashedToken = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");

    // 30 minutes expiry
    const expireDate = Date.now() + 30 * 60 * 1000;

    return { resetToken, hashedToken, expireDate };
  }

  /**
   * Validates if the user is between 18 and 100 years old.
   * @param {Date|string} dateOfBirth - The user's date of birth.
   * @returns {boolean} - True if valid, false otherwise.
   */
  validateAge(dateOfBirth) {
    if (!dateOfBirth) return false;
    
    const today = new Date();
    const birthDate = new Date(dateOfBirth);
    
    if (birthDate > today) {
      return false;
    }
    
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }
    
    return age >= 18 && age <= 100;
  }
}

export default new UserService();
