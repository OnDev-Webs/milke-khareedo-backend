const express = require('express');
const router = express.Router();
const propertyController = require('../controllers/propertyController');
const { authenticate, authorizeAdmin } = require('../middleware/auth');
const upload = require('../utils/multer');

// CRUD routes
router.post('/create_property', authenticate,authorizeAdmin, upload.fields([
    { name: "images", maxCount: 10 },
    { name: "layouts", maxCount: 10 },
    { name: "reraQrImage", maxCount: 1 }
]), propertyController.createProperty); // Admin only

router.get('/get_all_property', propertyController.getAllProperties); // Public 

router.get('/get_all_property_by_id/:id', propertyController.getPropertyById); // Public 

router.put('/update_property/:id', authenticate,authorizeAdmin, upload.fields([
    { name: "images", maxCount: 10 },
    { name: "layouts", maxCount: 10 },
    { name: "reraQrImage", maxCount: 1 }
]), propertyController.updateProperty); // Admin only

router.delete('delete_property/:id', authenticate,authorizeAdmin, propertyController.deleteProperty); // Admin only

module.exports = router;
