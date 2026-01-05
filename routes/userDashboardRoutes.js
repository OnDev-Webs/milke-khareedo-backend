const express = require('express');
const router = express.Router();
const userDashboardController = require('../controllers/userDashboardController');
const { authenticate, authorizeUser } = require('../middleware/auth');
const upload = require('../utils/multer');

// Dashboard 
router.get('/dashboard', authenticate, authorizeUser, userDashboardController.getUserDashboard);

// My Properties Tabs
router.post('/property/view', authenticate, userDashboardController.addViewedProperty);
router.post('/property/favorite', authenticate, userDashboardController.toggleFavoriteProperty);
router.post('/property/visit', authenticate, userDashboardController.registerVisit);
router.put('/property/update_visit/:leadId', authenticate, userDashboardController.registerUpdateVisit);

router.get('/get_search', authenticate, authorizeUser, userDashboardController.getSearchHistory);

router.post("/contact_preferences", authenticate, authorizeUser, userDashboardController.saveContactPreferences);  // Create/Update Preferences (Location, Budget, Floor)
router.get("/get_contact_preferences", authenticate, authorizeUser, userDashboardController.getContactPreferences);

// User Profile
router.get("/get_profile", authenticate, authorizeUser, userDashboardController.getProfile);
router.put("/update_profile", authenticate, authorizeUser, upload.single('profileImage'), userDashboardController.updateProfile);

router.get('/my-properties/viewed', authenticate, authorizeUser, userDashboardController.getViewedProperties);
router.get('/my-properties/favorited', authenticate, authorizeUser, userDashboardController.getFavoritedProperties);
router.get('/my-properties/visited', authenticate, authorizeUser, userDashboardController.getVisitedProperties);

module.exports = router;
