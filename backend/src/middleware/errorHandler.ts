import type { Request, Response, NextFunction } from 'express';

/**
 * Global error handler middleware
 *
 * Catches all unhandled errors and returns consistent JSON response
 */
export function errorHandler(
  error: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error('❌ Error:', error.message);
  console.error(error.stack);

  // CORS errors
  if (error.message.includes('not allowed by CORS')) {
    res.status(403).json({
      error: 'Forbidden',
      message: 'Origin not allowed by CORS policy',
    });
    return;
  }

  // Validation errors (Zod, etc.)
  if (error.name === 'ZodError') {
    res.status(400).json({
      error: 'Validation Error',
      message: error.message,
    });
    return;
  }

  // Generic server error
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'An error occurred',
  });
}

/**
 * 404 handler for unknown routes
 */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} does not exist`,
  });
}
