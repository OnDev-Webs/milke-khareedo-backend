const express = require('express');
const router = express.Router();

// Import route files
const userRoutes = require('./userRoutes');
const adminRoutes = require('./adminRoutes');
const productRoutes = require('./productRoutes');
const userDashboardRoutes = require('./userDashboardRoutes');
const homePageRoutes = require('./homePageRoutes');

// Route definitions
router.use('/users', userRoutes);
router.use('/admin',adminRoutes);
router.use('/products', productRoutes);
router.use('/user_dashboard', userDashboardRoutes);
router.use('/home', homePageRoutes);

// API info route
router.get('/', (req, res) => {
    res.json({
        success: true,
        message: 'API is working',
        version: '1.0.0',
        endpoints: {
            users: '/api/users',
            products: '/api/products',
            admin : '/api/admin'
        }
    });
});

module.exports = router;

