const express = require('express');
const router = express.Router();
const { authenticate, optionalAuthenticate } = require('../middleware/auth');
const homePageController = require('../controllers/homePageController');

router.get('/getTopProperty', optionalAuthenticate, homePageController.getTopVisitedProperties);

// Get all properties with search and location filtering
router.get('/properties', optionalAuthenticate, homePageController.getAllProperties);

// Get all unique locations
router.get('/locations', homePageController.getLocations);

// Search Properties API (GET request for property search)
router.get('/search-properties', optionalAuthenticate, homePageController.searchProperties);

// routes/homePageRoutes.js
router.get('/getPropertyById/:id', optionalAuthenticate, homePageController.getPropertyById);

// My Properties Tabs
router.post('/property/view', authenticate, homePageController.addViewedProperty);
router.post('/property/favorite', authenticate, homePageController.toggleFavoriteProperty);
router.post('/property/visit', authenticate, homePageController.registerVisit);

// Join Group Buy
router.post('/join-group', authenticate, homePageController.joinGroup);

// Property Comparison
router.post('/compare', optionalAuthenticate, homePageController.compareProperties);

// EMI Calculator
router.post('/emi-calculator', homePageController.calculateEMI);

// Contact Us
router.post('/contact-us', optionalAuthenticate, homePageController.contactUs);

// BLOG ROUTES
router.get('/blogs', homePageController.getAllBlogs);
router.get('/blog-categories', homePageController.getBlogCategories);
router.get('/blog/:idOrSlug', homePageController.getBlogById);

// ---------------- BLOG COMMENTS ----------------
router.get("/blog/:blogId/comments",optionalAuthenticate,homePageController.getBlogComments);
router.post("/blog/:blogId/comments", authenticate, homePageController.addBlogComment);
router.post("/blog/comments/:commentId/like", authenticate, homePageController.toggleCommentLike);

module.exports = router;
