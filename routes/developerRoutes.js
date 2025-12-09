const express = require('express');
const router = express.Router();
const developerController = require('../controllers/developerController');
const { authenticate, authorizeAdmin } = require('../middleware/auth'); 
const upload = require('../utils/multer');

// Routes
router.post('/create_developer',authenticate,authorizeAdmin, upload.single('logo'), developerController.createDeveloper); 
router.get('/get_all_developer', authenticate, authorizeAdmin,developerController.getAllDevelopers); 
router.get('/get_all_developer_by_id/:id', authenticate,authorizeAdmin, developerController.getDeveloperById); 
router.put('/update_developer/:id', authenticate, authorizeAdmin,developerController.updateDeveloper); 
router.delete('/delete_developer/:id', authenticate, authorizeAdmin,developerController.deleteDeveloper); 

module.exports = router;
