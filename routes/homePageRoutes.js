const express = require('express');
const router = express.Router();
const { authenticate, optionalAuthenticate } = require('../middleware/auth');
const homePageController = require('../controllers/homePageController');

router.get('/getTopProperty', homePageController.getTopVisitedProperties);

// routes/homePageRoutes.js
router.get('/getTopPropertyById/:id', authenticate, homePageController.getTopPropertyById);

// My Properties Tabs
router.post('/property/view', authenticate, homePageController.addViewedProperty);
router.post('/property/favorite', authenticate, homePageController.toggleFavoriteProperty);
router.post('/property/visit', authenticate, homePageController.registerVisit);

router.post('/search', optionalAuthenticate, homePageController.addSearchHistory);

// Property Comparison
router.post('/compare', homePageController.compareProperties);

module.exports = router;
