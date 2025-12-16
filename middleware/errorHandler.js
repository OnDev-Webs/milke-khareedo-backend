const { logError } = require('../utils/logger');

const errorHandler = (err, req, res, next) => {
    let error = { ...err };
    error.message = err.message;

    // Mongoose bad ObjectId
    if (err.name === 'CastError') {
        const message = 'Resource not found';
        error = { message, statusCode: 404 };
    }

    // Mongoose duplicate key
    if (err.code === 11000) {
        const message = 'Duplicate field value entered';
        error = { message, statusCode: 400 };
    }

    // Mongoose validation error
    if (err.name === 'ValidationError') {
        const message = Object.values(err.errors).map(val => val.message).join(', ');
        error = { message, statusCode: 400 };
    }

    // Log error to BetterStack
    logError('API Error', err, {
        method: req.method,
        url: req.originalUrl || req.url,
        statusCode: error.statusCode || 500,
        ip: req.ip || req.connection.remoteAddress,
        userId: req.user?.userId || null,
        body: req.method !== 'GET' ? req.body : undefined,
        query: req.query
    });

    // Also log to console for local development
    console.error('Error:', err);

    res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Server Error',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
};

module.exports = errorHandler;

