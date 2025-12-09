const express = require('express');
const router = express.Router();

// Import route files
const userRoutes = require('./userRoutes');
const productRoutes = require('./productRoutes');

// Route definitions
router.use('/users', userRoutes);
router.use('/products', productRoutes);

// API info route
router.get('/', (req, res) => {
    res.json({
        success: true,
        message: 'API is working',
        version: '1.0.0',
        endpoints: {
            users: '/api/users',
            products: '/api/products'
        }
    });
});

module.exports = router;

