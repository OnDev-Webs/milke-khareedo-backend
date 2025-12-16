const { Logtail } = require('@logtail/node');
const winston = require('winston');
const { LogtailTransport } = require('@logtail/winston');

// Initialize BetterStack logger
const logtail = new Logtail(process.env.BETTERSTACK_SOURCE_TOKEN || '');

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
    ]
});

// Add BetterStack transport only if token is provided
if (process.env.BETTERSTACK_SOURCE_TOKEN) {
    logger.add(new LogtailTransport(logtail));
}

// Helper methods for different log levels
const logInfo = (message, meta = {}) => {
    logger.info(message, meta);
};

const logError = (message, error = null, meta = {}) => {
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
};

const logWarn = (message, meta = {}) => {
    logger.warn(message, meta);
};

const logDebug = (message, meta = {}) => {
    logger.debug(message, meta);
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

module.exports = {
    logger,
    logInfo,
    logError,
    logWarn,
    logDebug,
    logApiRequest,
    logtail
};
