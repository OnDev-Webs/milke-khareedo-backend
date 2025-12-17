const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const validate = require('../middleware/validator');
const { body } = require('express-validator');
const { authenticate, authorizeAdmin, authorizeSuperAdmin } = require('../middleware/auth');
const upload = require('../utils/multer');

// AUTH ROUTES
router.post('/superadmin/register', [
    body('email').isEmail().withMessage('Please provide a valid email'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
], validate, adminController.registerSuperAdmin);

// ADMIN LOGIN
router.post('/admin_login', validate, adminController.adminLogin);

// GET PROFILE
router.get('/get_admin_profile', authenticate, authorizeAdmin, adminController.getAdminProfile);

// UPDATE PROFILE
router.put('/update_admin_profile', authenticate, authorizeAdmin, upload.single('profileImage'), adminController.updateAdminProfile);

// CHANGE PASSWORD
router.post('/change_password', authenticate, authorizeAdmin, adminController.changePassword);

// ADMIN DASHBOARD ROUTES
router.get('/admin_dashboard', authenticate, authorizeAdmin, adminController.getAdminDashboard);
router.get('/dashboard/recent-leads', authenticate, adminController.getRecentLeads);
router.get('/leads/filter', authenticate, adminController.getFilteredLeads);

// USER MANAGEMENT ROUTES
router.get('/get_all_user', authenticate, authorizeAdmin, adminController.getAllUsers);
router.get('/get_all_user_by_id/:id', authenticate, authorizeAdmin, adminController.getUserById);


// CREATE PROPERTY ROUTES
router.post('/create_property', authenticate, upload.fields([
    { name: "images", maxCount: 10 },
    { name: "layouts", maxCount: 10 },
    { name: "reraQrImage", maxCount: 1 }
]), authorizeAdmin, adminController.createProperty);

router.get('/get_all_property', adminController.getAllProperties);

router.get('/get_all_property_by_id/:id', adminController.getPropertyById);

router.put('/update_property/:id', authenticate, upload.fields([
    { name: "images", maxCount: 10 },
    { name: "layouts", maxCount: 10 },
    { name: "reraQrImage", maxCount: 1 }
]), authorizeAdmin, adminController.updateProperty);

router.delete('/delete_property/:id', authenticate, authorizeAdmin, adminController.deleteProperty);

// DEVELOPER ROUTES 
router.post('/create_developer', authenticate, upload.single('logo'), authorizeAdmin, adminController.createDeveloper);
router.get('/get_all_developer', authenticate, authorizeAdmin, adminController.getAllDevelopers);
router.get('/get_all_developer_by_id/:id', authenticate, authorizeAdmin, adminController.getDeveloperById);
router.put('/update_developer/:id', authenticate, authorizeAdmin, upload.single("logo"), adminController.updateDeveloper);
router.delete('/delete_developer/:id', authenticate, authorizeAdmin, adminController.deleteDeveloper);

//LEAD MANAGEMENT ROUTES
router.get('/lead_list', authenticate, adminController.getLeadsList);
router.get('/view_lead_list/:leadId', authenticate, adminController.viewLeadDetails);
router.delete('/delete_lead_list/:leadId', authenticate, adminController.deleteLead);

// Lead Timeline/Activity Routes
router.post('/lead/:leadId/activity', authenticate, adminController.addLeadActivity);
router.put('/lead/:leadId/status', authenticate, adminController.updateLeadStatus);
router.put('/lead/:leadId/remark', authenticate, adminController.updateLeadRemark);
router.get('/lead/:leadId/timeline', authenticate, adminController.getLeadTimeline);

// ROLE MANAGEMENT ROUTES
router.get('/get_agent_role', authenticate, authorizeAdmin, adminController.getAgentRoles);
router.get('/get_relationship_manager', authenticate, authorizeAdmin, adminController.getRelationshipManagers);

// ROLE ROUTES
router.post('/add_role', authenticate, authorizeSuperAdmin, adminController.addRole);
router.get('/get_role', authenticate, authorizeAdmin, adminController.getAllRoles);
router.get('/get_role_by_id/:id', authenticate, authorizeAdmin, adminController.getRoleById);
router.put('/update_role/:id', authenticate, authorizeSuperAdmin, adminController.updateRole);
router.delete('/delete_role/:id', authenticate, authorizeSuperAdmin, adminController.deleteRole);

// ASSIGN NEW USER ROUTES
router.post('/create_user', authenticate, authorizeSuperAdmin, adminController.createUser);
router.get('/', authenticate, authorizeAdmin, adminController.getAllAssignUsers);
router.get('/:id', authenticate, authorizeAdmin, adminController.getAssignUserById);
router.put('/update_user/:id', authenticate, authorizeSuperAdmin, adminController.updateAssignUser);
router.delete('/delete_user/:id', authenticate, authorizeSuperAdmin, adminController.deleteAssignUser);

module.exports = router;

