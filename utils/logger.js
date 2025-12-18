const { Logtail } = require('@logtail/node');
const winston = require('winston');
const { LogtailTransport } = require('@logtail/winston');

// Initialize BetterStack logger with error handling
let logtail = null;
try {
    if (process.env.BETTERSTACK_SOURCE_TOKEN) {
        logtail = new Logtail(process.env.BETTERSTACK_SOURCE_TOKEN);
    }
} catch (error) {
    console.warn('Failed to initialize BetterStack logger:', error.message);
    logtail = null;
}

// Create Winston logger with BetterStack transport
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.splat(),
        winston.format.json()
    ),
    defaultMeta: { service: 'milke-khareedo-backend' },
    transports: [
        // Console transport for local development
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.printf(({ timestamp, level, message, ...meta }) => {
                    return `${timestamp} [${level}]: ${message} ${Object.keys(meta).length ? JSON.stringify(meta, null, 2) : ''}`;
                })
            )
        })
    ],
    // Handle exceptions and rejections gracefully
    exceptionHandlers: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.printf(({ timestamp, level, message, ...meta }) => {
                    return `${timestamp} [${level}]: ${message} ${Object.keys(meta).length ? JSON.stringify(meta, null, 2) : ''}`;
                })
            )
        })
    ],
    rejectionHandlers: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.printf(({ timestamp, level, message, ...meta }) => {
                    return `${timestamp} [${level}]: ${message} ${Object.keys(meta).length ? JSON.stringify(meta, null, 2) : ''}`;
                })
            )
        })
    ]
});

// Add BetterStack transport only if token is provided and initialized successfully
if (logtail && process.env.BETTERSTACK_SOURCE_TOKEN) {
    try {
        const betterStackTransport = new LogtailTransport(logtail, {
            // Add options to handle errors gracefully
            handleExceptions: false,
            handleRejections: false,
            silent: false, // Don't silence, but handle errors
        });

        // Add error handler to prevent crashes - catch all error events
        betterStackTransport.on('error', (error) => {
            // Silently ignore BetterStack errors - don't crash the app
            // Don't log to avoid infinite loops
        });

        // Wrap the transport's log method to catch any errors at the source
        const originalLog = betterStackTransport.log.bind(betterStackTransport);
        betterStackTransport.log = function (info, callback) {
            // Use setImmediate to prevent blocking and catch async errors
            setImmediate(() => {
                try {
                    originalLog(info, (err) => {
                        // Silently ignore all errors - don't propagate
                        if (callback) {
                            try {
                                callback(null);
                            } catch (e) {
                                // Ignore callback errors too
                            }
                        }
                    });
                } catch (error) {
                    // Silently catch and ignore all errors
                    if (callback) {
                        try {
                            callback(null);
                        } catch (e) {
                            // Ignore callback errors
                        }
                    }
                }
            });
            return betterStackTransport;
        };

        // Override the transport's error handling
        const originalEmit = betterStackTransport.emit.bind(betterStackTransport);
        betterStackTransport.emit = function (event, ...args) {
            if (event === 'error') {
                // Silently swallow all error events
                return true;
            }
            return originalEmit(event, ...args);
        };

        logger.add(betterStackTransport);
    } catch (error) {
        // Silently continue without BetterStack logging
        if (process.env.NODE_ENV !== 'production') {
            console.warn('BetterStack transport disabled due to initialization error');
        }
    }
}

// Helper methods for different log levels with error handling
const logInfo = (message, meta = {}) => {
    try {
        logger.info(message, meta);
    } catch (error) {
        // Fallback to console if logger fails
        console.log(`[INFO]: ${message}`, meta);
    }
};

const logError = (message, error = null, meta = {}) => {
    try {
        const errorMeta = {
            ...meta,
            ...(error && {
                error: {
                    message: error.message,
                    stack: error.stack,
                    name: error.name
                }
            })
        };
        logger.error(message, errorMeta);
    } catch (logErr) {
        // Fallback to console if logger fails
        console.error(`[ERROR]: ${message}`, meta, error);
    }
};

const logWarn = (message, meta = {}) => {
    try {
        logger.warn(message, meta);
    } catch (error) {
        // Fallback to console if logger fails
        console.warn(`[WARN]: ${message}`, meta);
    }
};

const logDebug = (message, meta = {}) => {
    try {
        logger.debug(message, meta);
    } catch (error) {
        // Fallback to console if logger fails
        console.debug(`[DEBUG]: ${message}`, meta);
    }
};

// API request/response logger
const logApiRequest = (req, res, responseTime) => {
    const logData = {
        method: req.method,
        url: req.originalUrl || req.url,
        statusCode: res.statusCode,
        responseTime: `${responseTime}ms`,
        ip: req.ip || req.connection.remoteAddress,
        userAgent: req.get('user-agent'),
        userId: req.user?.userId || null,
        query: Object.keys(req.query).length > 0 ? req.query : undefined,
        body: req.method !== 'GET' ? sanitizeBody(req.body) : undefined
    };

    if (res.statusCode >= 400) {
        logWarn('API Request', logData);
    } else {
        logInfo('API Request', logData);
    }
};

// Sanitize sensitive data from request body
const sanitizeBody = (body) => {
    if (!body || typeof body !== 'object') return body;

    const sensitiveFields = ['password', 'token', 'secret', 'apiKey', 'authorization'];
    const sanitized = { ...body };

    sensitiveFields.forEach(field => {
        if (sanitized[field]) {
            sanitized[field] = '***REDACTED***';
        }
    });

    return sanitized;
};

// Handle unhandled promise rejections from BetterStack
process.on('unhandledRejection', (reason, promise) => {
    // Silently ignore BetterStack-related errors
    if (reason && typeof reason === 'object') {
        const errorMessage = reason.message || reason.toString() || '';
        const errorStack = reason.stack || '';

        // Check if it's a BetterStack/Logtail error
        if (errorMessage.includes('betterstack') ||
            errorMessage.includes('logtail') ||
            errorMessage.includes('in.logs.betterstack.com') ||
            errorStack.includes('betterstack') ||
            errorStack.includes('logtail')) {
            // Silently ignore - don't crash the app
            return;
        }
    }

    // For other unhandled rejections, log them
    if (process.env.NODE_ENV !== 'production') {
        console.error('Unhandled Rejection:', reason);
    }
});

module.exports = {
    logger,
    logInfo,
    logError,
    logWarn,
    logDebug,
    logApiRequest,
    logtail
};
