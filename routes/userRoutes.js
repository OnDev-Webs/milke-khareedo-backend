const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validator');
const { body } = require('express-validator');
const upload = require('../utils/multer');

// Validation rules

const loginValidation = [
    body('email').isEmail().withMessage('Please provide a valid email'),
    body('password').notEmpty().withMessage('Password is required')
];

// Routes
router.post('/register', validate, userController.register);
router.post('/login', loginValidation, validate, userController.login);
router.post('/social-login/google', userController.googleLogin);
router.get('/profile', authenticate, userController.getProfile);

// OTP Routes
router.post('/verify-otp', userController.verifyOTP);
router.post('/resend-otp', userController.resendOTP);
router.post('/forgot-password', userController.forgotPassword);
router.post('/reset-password', userController.resetPassword);

router.put('/:id', authenticate, upload.single('profileImage'), userController.updateUser);
router.delete('/:id', authenticate, userController.deleteUser);

module.exports = router;

