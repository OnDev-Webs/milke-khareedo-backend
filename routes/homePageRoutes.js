const express = require('express');
const router = express.Router();
const { authenticate, optionalAuthenticate } = require('../middleware/auth');
const homePageController = require('../controllers/homePageController');

router.get('/getTopProperty', homePageController.getTopVisitedProperties);

// Get all unique locations
router.get('/locations', homePageController.getLocations);

// Search Properties API (GET request for property search)
router.get('/search-properties', optionalAuthenticate, homePageController.searchProperties);

// routes/homePageRoutes.js
router.get('/getPropertyById/:id', authenticate, homePageController.getPropertyById);

// My Properties Tabs
router.post('/property/view', authenticate, homePageController.addViewedProperty);
router.post('/property/favorite', authenticate, homePageController.toggleFavoriteProperty);
router.post('/property/visit', authenticate, homePageController.registerVisit);

// Join Group Buy
router.post('/join-group', authenticate, homePageController.joinGroup);

// router.post('/search', optionalAuthenticate, homePageController.addSearchHistory);

// Property Comparison
router.post('/compare', homePageController.compareProperties);

// EMI Calculator
router.post('/emi-calculator', homePageController.calculateEMI);

// Contact Us
router.post('/contact-us', optionalAuthenticate, homePageController.contactUs);

module.exports = router;
