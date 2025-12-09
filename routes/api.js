const express = require('express');
const router = express.Router();

require('../models/developer');
require('../models/property');


// Import route files
const userRoutes = require('./userRoutes');
const productRoutes = require('./productRoutes');
const propertyRoutes = require('./propertyRoutes');
const developerRoutes = require('./developerRoutes');
const adminProfileRoutes = require('./adminProfileRoutes');

// Route definitions
router.use('/users', userRoutes);
router.use('/products', productRoutes);
router.use('/properties', propertyRoutes);
router.use('/developers', developerRoutes);
router.use('/admin_profile', adminProfileRoutes);

// API info route
router.get('/', (req, res) => {
    res.json({
        success: true,
        message: 'API is working',
        version: '1.0.0',
        endpoints: {
            users: '/api/users',
            products: '/api/products',
            property: '/api/property'
        }
    });
});

module.exports = router;

