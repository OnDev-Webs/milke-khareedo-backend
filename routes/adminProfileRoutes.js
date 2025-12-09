const express = require('express');
const router = express.Router();
const { authenticate, authorizeAdmin } = require('../middleware/auth'); 
const adminProfileController = require('../controllers/adminProfileController');

// Routes
router.get('/get_all_property', adminProfileController.getAllProperties); 
router.get('/get_all_developer', authenticate,authorizeAdmin, adminProfileController.getAllDevelopers);  

// Dashboard
router.get('/dashboard', authenticate, authorizeAdmin, adminProfileController.getAdminDashboard);

module.exports = router;