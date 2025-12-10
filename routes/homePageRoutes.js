const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const homePageController = require('../controllers/homePageController');

router.get('/getAllProperty', homePageController.getAllProperties);

router.get('/getAllPropertyById/:id', homePageController.getPropertyById);

// My Properties Tabs
router.post('/property/view', authenticate, homePageController.addViewedProperty);
router.post('/property/favorite', authenticate, homePageController.toggleFavoriteProperty);
router.post('/property/visit', authenticate, homePageController.registerVisit);

router.post('/search', authenticate, homePageController.addSearchHistory);

module.exports = router;
