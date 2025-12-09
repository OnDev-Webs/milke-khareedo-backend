const express = require('express');
const router = express.Router();
const productController = require('../controllers/productController');
const { authenticate } = require('../middleware/auth');
const  validate = require('../middleware/validator');
const { body } = require('express-validator');

// Validation rules
const productValidation = [
    body('name').trim().notEmpty().withMessage('Product name is required'),
    body('price').isFloat({ min: 0 }).withMessage('Price must be a positive number'),
    body('description').optional().trim()
];

// Routes
router.get('/', productController.getAllProducts);
router.get('/:id', productController.getProductById);
router.post('/', authenticate, productValidation, validate, productController.createProduct);
router.put('/:id', authenticate, productValidation, validate, productController.updateProduct);
router.delete('/:id', authenticate, productController.deleteProduct);

module.exports = router;

