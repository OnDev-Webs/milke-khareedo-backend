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

router.post('/admin_login',validate ,adminController.adminLogin);

// ADMIN DASHBOARD ROUTES
router.get('/admin_dashboard', authenticate, authorizeAdmin ,adminController.getAdminDashboard);

// CREATE PROPERTY ROUTES
router.post('/create_property', authenticate,upload.fields([
    { name: "images", maxCount: 10 },
    { name: "layouts", maxCount: 10 },
    { name: "reraQrImage", maxCount: 1 }
]),authorizeAdmin, adminController.createProperty); 

router.get('/get_all_property', adminController.getAllProperties); 

router.get('/get_all_property_by_id/:id', adminController.getPropertyById); 

router.put('/update_property/:id', authenticate,upload.fields([
    { name: "images", maxCount: 10 },
    { name: "layouts", maxCount: 10 },
    { name: "reraQrImage", maxCount: 1 }
]), authorizeAdmin , adminController.updateProperty); 

router.delete('/delete_property/:id', authenticate,authorizeAdmin, adminController.deleteProperty); 

// DEVELOPER ROUTES 
router.post('/create_developer',authenticate, upload.single('logo'),authorizeAdmin, adminController.createDeveloper); 
router.get('/get_all_developer', authenticate, authorizeAdmin ,adminController.getAllDevelopers); 
router.get('/get_all_developer_by_id/:id', authenticate, authorizeAdmin, adminController.getDeveloperById); 
router.put('/update_developer/:id', authenticate, authorizeAdmin, upload.single("logo") ,adminController.updateDeveloper); 
router.delete('/delete_developer/:id', authenticate, authorizeAdmin,adminController.deleteDeveloper); 

//LEAD MANAGEMENT ROUTES
router.get('/lead_list', authenticate, adminController.getLeadsList);
router.get('/view_lead_list/:leadId', authenticate, adminController.viewLeadDetails);
router.delete('/delete_lead_list/:leadId', authenticate, adminController.deleteLead);

// ROLE ROUTES
router.post('/add_role', authenticate, authorizeSuperAdmin ,adminController.addRole);
router.get('/get_role', authenticate, authorizeAdmin, adminController.getAllRoles);
router.get('/get_role_by_id/:id', authenticate, authorizeAdmin ,adminController.getRoleById);
router.put('/update_role/:id', authenticate, authorizeSuperAdmin, adminController.updateRole);
router.delete('/delete_role/:id', authenticate, authorizeSuperAdmin ,adminController.deleteRole);

// ASSIGN NEW USER ROUTES
router.post('/create_user',authenticate,authorizeSuperAdmin, adminController.createUser);
router.get('/', authenticate,authorizeAdmin,adminController.getAllAssignUsers);
router.get('/:id', authenticate, authorizeAdmin ,adminController.getAssignUserById);
router.put('/update_user/:id', authenticate , authorizeSuperAdmin ,adminController.updateAssignUser);
router.delete('/delete_user/:id',authenticate,authorizeSuperAdmin, adminController.deleteAssignUser);

module.exports = router;

