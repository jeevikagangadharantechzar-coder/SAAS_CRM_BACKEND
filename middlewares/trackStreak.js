import Streak from '../models/streak.model.js';
export const trackLogin = async (req, res, next) => {
  try {
    // Only track if user is authenticated
    if (req.user && req.user._id) {
      setTimeout(async () => {
        try {
          const userId = req.user._id;
          const today = new Date();
          let streak = await Streak.findOne({ userId });
          if (!streak) {
            streak = await Streak.create({ userId });
          }
          const todayString = today.toDateString();
          const lastLoginDate = streak.lastLoginDate ? new Date(streak.lastLoginDate) : null;
          const lastLoginString = lastLoginDate ? lastLoginDate.toDateString() : null;
          // Only update if it's a new day
          if (!lastLoginString || todayString !== lastLoginString) {
            if (lastLoginDate) {
              const yesterday = new Date(today);
              yesterday.setDate(yesterday.getDate() - 1);
              const yesterdayString = yesterday.toDateString();
              if (lastLoginString === yesterdayString) {
                // Consecutive day
                streak.currentStreak += 1;
                if (streak.currentStreak > streak.longestStreak) {
                  streak.longestStreak = streak.currentStreak;
                }
              } else {
                // Streak broken
                streak.currentStreak = 1;
              }
            } else {
              // First login
              streak.currentStreak = 1;
            }
            streak.productiveDays += 1;
            streak.lastLoginDate = today;
          }
          // Add to login history
          streak.loginHistory.push({
            date: today,
            activity: 'login',
            timestamp: new Date()
          });
          // Keep only last 90 days
          if (streak.loginHistory.length > 90) {
            streak.loginHistory = streak.loginHistory.slice(-90);
          }
          await streak.save();
          console.log(` Streak updated for user ${userId}: ${streak.currentStreak} days`);
        } catch (error) {
          console.error('Error updating streak in background:', error);
        }
      }, 0);
    }
    next();
  } catch (error) {
    console.error('Track login middleware error:', error);
    next(error);
  }
};