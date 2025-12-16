const { logApiRequest } = require('../utils/logger');

// Middleware to log API requests and responses
const apiLogger = (req, res, next) => {
    const startTime = Date.now();

    // Override res.json to capture response
    const originalJson = res.json.bind(res);
    res.json = function (data) {
        const responseTime = Date.now() - startTime;
        logApiRequest(req, res, responseTime);
        return originalJson(data);
    };

    // Handle errors
    res.on('finish', () => {
        if (!res.headersSent) {
            const responseTime = Date.now() - startTime;
            logApiRequest(req, res, responseTime);
        }
    });

    next();
};

module.exports = apiLogger;
