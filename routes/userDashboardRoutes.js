const express = require('express');
const router = express.Router();
const userDashboardController = require('../controllers/userDashboardController');
const { authenticate, authorizeUser } = require('../middleware/auth');

// Dashboard 
router.get('/dashboard', authenticate, authorizeUser, userDashboardController.getUserDashboard);

// My Properties Tabs
router.post('/property/view', authenticate, userDashboardController.addViewedProperty);
router.post('/property/favorite', authenticate, userDashboardController.toggleFavoriteProperty);
router.post('/property/visit', authenticate, userDashboardController.registerVisit);
router.put('/property/update_visit/:leadId', authenticate, userDashboardController.registerUpdateVisit);

router.get('/get_search', authenticate, authorizeUser ,userDashboardController.getSearchHistory);

router.post("/contact_preferences", authenticate,authorizeUser, userDashboardController.saveContactPreferences);  // Create/Update
router.get("/get_contact_preferences", authenticate, authorizeUser, userDashboardController.getContactPreferences);    

router.get('/my-properties/viewed', authenticate,authorizeUser, userDashboardController.getViewedProperties);
router.get('/my-properties/favorited', authenticate, authorizeUser, userDashboardController.getFavoritedProperties);
router.get('/my-properties/visited', authenticate, authorizeUser, userDashboardController.getVisitedProperties);

module.exports = router;
