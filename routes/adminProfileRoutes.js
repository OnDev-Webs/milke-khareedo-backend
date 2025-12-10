const express = require('express');
const router = express.Router();
const { authenticate, authorizeAdmin } = require('../middleware/auth'); 
const adminProfileController = require('../controllers/adminProfileController');

// Routes
router.get('/get_all_property', adminProfileController.getAllProperties); 
router.get('/get_all_developer', authenticate,authorizeAdmin, adminProfileController.getAllDevelopers);  

// Dashboard
router.get('/dashboard', authenticate, authorizeAdmin, adminProfileController.getAdminDashboard);

router.get('/lead_list', authenticate, adminProfileController.getLeadsList);
router.get('/view_lead_list/:leadId', authenticate, adminProfileController.viewLeadDetails);
router.delete('/delete_lead_list/:leadId', authenticate, adminProfileController.deleteLead);

module.exports = router;