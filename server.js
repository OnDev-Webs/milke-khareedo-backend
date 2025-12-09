const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
require('dotenv').config();

const connectDB = require('./config/database');

// Connect to database
connectDB();

const app = express();

// Import routes and middleware
const apiRoutes = require('./routes/api');
const errorHandler = require('./middleware/errorHandler');

// Middleware
app.use(helmet()); // Security headers
app.use(cors()); // Enable CORS
app.use(morgan('dev')); // Logging
app.use(express.json()); // Parse JSON bodies
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded bodies

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
    console.log(`Server is running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;

