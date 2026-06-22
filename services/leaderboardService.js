import axios from "axios";
class LeaderboardService {
  constructor() {
    this.API_URL = import.meta.env.VITE_API_URL;
    this.token = localStorage.getItem("token");
  }
  // Get auth headers
  getHeaders() {
    return {
      headers: { Authorization: `Bearer ${this.token}` }
    };
  }
  // Fetch all sales users
  async fetchSalesUsers() {
    try {
      const { data } = await axios.get(
        `${this.API_URL}/users/sales`,
        this.getHeaders()
      );
      return data.users || [];
    } catch (error) {
      console.error("Error fetching sales users:", error);
      // Fallback to current user
      const userData = JSON.parse(localStorage.getItem("user") || "{}");
      return userData._id ? [userData] : [];
    }
  }
  // Fetch all leads
  async fetchAllLeads() {
    try {
      const { data } = await axios.get(
        `${this.API_URL}/leads/getAllLead`,
        this.getHeaders()
      );
      return data || [];
    } catch (error) {
      console.error("Error fetching leads:", error);
      return [];
    }
  }
  // Fetch all deals
  async fetchAllDeals() {
    try {
      const { data } = await axios.get(
        `${this.API_URL}/deals/getAll`,
        this.getHeaders()
      );
      return data || [];
    } catch (error) {
      console.error("Error fetching deals:", error);
      return [];
    }
  }
  // Fetch login history for a specific user
  async fetchUserLoginHistory(userId) {
    try {
      const { data } = await axios.get(
        `${this.API_URL}/streak/login-history/${userId}`,
        this.getHeaders()
      );
      return data.loginHistory || [];
    } catch (error) {
      console.error(`Error fetching login history for user ${userId}:`, error);
      // Fallback: Check localStorage
      try {
        const stored = localStorage.getItem(`user_login_${userId}`);
        return stored ? JSON.parse(stored) : [];
      } catch {
        return [];
      }
    }
  }
  // Fetch login histories for multiple users in parallel
  async fetchAllUsersLoginHistory(users) {
    const loginHistoryPromises = users.map(async (user) => {
      const history = await this.fetchUserLoginHistory(user._id);
      return {
        userId: user._id,
        history: history.map(log => ({
          ...log,
          userId: user._id,
          userName: `${user.firstName || ''} ${user.lastName || ''}`.trim()
        }))
      };
    });
    const results = await Promise.all(loginHistoryPromises);
    return results.reduce((acc, curr) => {
      acc[curr.userId] = curr.history;
      return acc;
    }, {});
  }
}
export default new LeaderboardService();