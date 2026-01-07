const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const validate = require('../middleware/validator');
const { body } = require('express-validator');
const { authenticate, authorizeAdmin, authorizeSuperAdmin, authorizeBlogAdd, authorizeBlogEdit, authorizeBlogView, authorizeBlogDelete } = require('../middleware/auth');
const upload = require('../utils/multer');

// AUTH ROUTES
router.post('/superadmin/register', [
    body('email').isEmail().withMessage('Please provide a valid email'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
], validate, adminController.registerSuperAdmin);

// ADMIN LOGIN
router.post('/login', validate, adminController.adminLogin);

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

// CRM DASHBOARD ROUTE
router.get('/crm-dashboard', authenticate, adminController.getCRMDashboard);

// CRM PROFILE ROUTES
router.get('/crm/profile', authenticate, adminController.getCRMProfile);
router.put('/crm/profile', authenticate, upload.single('profileImage'), adminController.updateCRMProfile);

// NOTIFICATION ROUTES
router.get('/notifications', authenticate, adminController.getNotifications);
router.put('/notifications/mark-all-read', authenticate, adminController.markAllNotificationsAsRead);

// USER MANAGEMENT ROUTES
router.get('/get_all_user', authenticate, authorizeAdmin, adminController.getAllUsers);
router.get('/get_all_user_by_id/:id', authenticate, authorizeAdmin, adminController.getUserById);
router.put('/toggle_user_status/:id', authenticate, authorizeAdmin, adminController.toggleUserStatus);


// CREATE PROPERTY ROUTES
router.post(
    "/create_property",
    authenticate,
    upload.any(),
    authorizeAdmin,
    adminController.createProperty
);


router.get('/get_all_property', adminController.getAllProperties);

router.get('/get_all_property_by_id/:id', adminController.getPropertyById);

const uploadMiddleware = (req, res, next) => {
  if (req.method === "OPTIONS") return next();
  upload.any()(req, res, next);
};


router.put('/update_property/:id', authenticate, authorizeAdmin, uploadMiddleware, adminController.updateProperty);

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
// EXPORT lEAD lIST AS CSV
router.get('/leads/:leadId/export-csv', authenticate, adminController.exportLeadDetailsCSV);
// EXPORT ALL LEADS AS CSV
router.get('/export_all_leads_csv', authenticate, adminController.exportAllLeadsCSV);

// Lead Timeline/Activity Routes
router.post('/lead/:leadId/activity', authenticate, adminController.addLeadActivity);
router.put('/lead/:leadId/status', authenticate, adminController.updateLeadStatus);
router.put('/lead/:leadId/remark', authenticate, adminController.updateLeadRemark);
router.get('/lead/:leadId/timeline', authenticate, adminController.getLeadTimeline);
router.post('/lead/:leadId/follow-up', authenticate, adminController.scheduleFollowUp);
router.post('/lead/:leadId/call', authenticate, adminController.callNow);
router.post('/lead/:leadId/whatsapp', authenticate, adminController.sendWhatsApp);

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
router.get('/get_user/:id', authenticate, authorizeAdmin, adminController.getAssignUserById);
router.put('/update_user/:id', authenticate, authorizeSuperAdmin,upload.single('profileImage'), adminController.updateAssignUser);
router.delete('/delete_user/:id', authenticate, authorizeSuperAdmin, adminController.deleteAssignUser);

// BLOG MANAGEMENT ROUTES (with permission checks)
router.post('/blog', authenticate, upload.fields([
    { name: 'bannerImage', maxCount: 1 }
]), authorizeBlogAdd, adminController.createBlog);

router.get('/blogs', authenticate, authorizeBlogView, adminController.getAllBlogs);

router.get('/blog/:id', authenticate, authorizeBlogView, adminController.getBlogById);

router.put('/blog/:id', authenticate, upload.fields([
    { name: 'bannerImage', maxCount: 1 }
]), authorizeBlogEdit, adminController.updateBlog);
router.delete('/blog/:id', authenticate, authorizeBlogDelete, adminController.deleteBlog);

module.exports = router;

