const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { authenticate, authorizeAdmin } = require('../middleware/auth');
const validate = require('../middleware/validator');
const { body } = require('express-validator');

// Validation rules
const registerValidation = [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().withMessage('Please provide a valid email'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
];

const loginValidation = [
    body('email').isEmail().withMessage('Please provide a valid email'),
    body('password').notEmpty().withMessage('Password is required')
];

// Routes
router.post('/register', registerValidation, validate, userController.register);
router.post('/login', loginValidation, validate, userController.login);
router.post('/social-login/google', userController.googleLogin);
router.get('/profile', authenticate, userController.getProfile);

router.get('/', authenticate, authorizeAdmin ,userController.getAllUsers);
router.get('/:id', authenticate,authorizeAdmin, userController.getUserById);
router.put('/:id', authenticate, authorizeAdmin,userController.updateUser);
router.delete('/:id', authenticate,authorizeAdmin, userController.deleteUser);

module.exports = router;

