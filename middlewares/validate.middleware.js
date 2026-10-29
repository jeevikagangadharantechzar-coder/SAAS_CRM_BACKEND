/**
 * Generic Validation Middleware Factory
 * Checks request parameters and bodies against defined validation rules.
 */

export const validateRequest = (validatorFn) => {
  return (req, res, next) => {
    const error = validatorFn(req);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error,
        code: "VALIDATION_ERROR",
      });
    }
    next();
  };
};
