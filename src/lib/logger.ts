// Secure logging utility - only verbose in development mode
const isDev = process.env.NODE_ENV !== 'production';

export const logger = {
    // Always log these (safe for production)
    info: (...args: any[]) => {
        console.log(...args);
    },

    // Only log in development (may contain sensitive info)
    debug: (...args: any[]) => {
        if (isDev) {
            console.debug(...args);
        }
    },

    // Safe error logging - sanitizes in production
    error: (message: string, error?: any) => {
        if (isDev) {
            // Development: log full error details
            console.error(message, error);
        } else {
            // Production: log only the message, not error details
            console.error(message);
        }
    },

    // Log error with context but sanitize sensitive data in production
    errorWithContext: (message: string, context?: Record<string, any>, error?: any) => {
        if (isDev) {
            console.error(message, context, error);
        } else {
            // In production, only log the message
            console.error(message);
        }
    }
};
