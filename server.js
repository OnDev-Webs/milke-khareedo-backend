const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
const compression = require('compression');
require('dotenv').config();

const connectDB = require('./config/database');
const { logInfo, logError } = require('./utils/logger');
const apiLogger = require('./middleware/logger');

// Connect to database
connectDB();

const app = express();

// Import routes and middleware
const apiRoutes = require('./routes/api');
const errorHandler = require('./middleware/errorHandler');

// Middleware
app.use(helmet()); // Security headers
app.use(cors()); // Enable CORS
app.use(compression()); // Compress responses for faster transfer
app.use(morgan('dev')); // HTTP request logger
app.use(express.json({ limit: '10mb' })); // Parse JSON bodies
app.use(express.urlencoded({ extended: true, limit: '10mb' })); // Parse URL-encoded bodies
app.use(apiLogger); // API request/response logger

// Health check route
app.get('/', (req, res) => {
    res.json({
        message: 'Milke Khareedo Backend API',
        status: 'running',
        version: '1.0.0'
    });
});

// API routes
app.use('/api', apiRoutes);

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Route not found'
    });
});

// Error handling middleware (must be last)
app.use(errorHandler);

// Start server
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
    logInfo(`Server is running on port ${PORT}`, {
        environment: process.env.NODE_ENV || 'development',
        port: PORT
    });
    console.log(`Server is running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;

