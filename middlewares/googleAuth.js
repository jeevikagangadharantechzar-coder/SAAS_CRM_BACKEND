import User from '../models/user.model.js';

const googleAuth = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    
    if (!user.googleAuth || !user.googleAuth.accessToken) {
      return res.status(401).json({
        success: false,
        message: 'Google authentication required. Please connect your Google account.',
        requiresAuth: true
      });
    }

    // Check if token is expired or about to expire (within 5 minutes)
    const isExpired = Date.now() >= (user.googleAuth.expiryDate - 300000);
    
    if (isExpired) {
      return res.status(401).json({
        success: false,
        message: 'Google authentication token expired. Please reconnect your Google account.',
        requiresAuth: true
      });
    }

    // Attach Google auth info to request for use in controllers
    req.googleAuth = user.googleAuth;
    next();
  } catch (error) {
    console.error('Google auth middleware error:', error);
    res.status(500).json({
      success: false,
      message: 'Google authentication error',
      error: error.message
    });
  }
};

export default googleAuth;