const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validator');
const { body } = require('express-validator');
const upload = require('../utils/multer');

// Validation rules


const phoneLoginValidation = [
    body('phoneNumber')
        .isLength({ min: 10, max: 10 })
        .withMessage('Phone number must be exactly 10 digits')
        .matches(/^[0-9]{10}$/)
        .withMessage('Phone number must contain only digits'),
    body('countryCode')
        .optional()
        .matches(/^\+[0-9]{1,4}$/)
        .withMessage('Country code must start with + and be 1-4 digits (e.g., +91)')
];

const verifyOTPValidation = [
    body('phoneNumber')
        .notEmpty()
        .withMessage('Phone number is required')
        .isLength({ min: 10, max: 10 })
        .withMessage('Phone number must be exactly 10 digits')
        .matches(/^[0-9]{10}$/)
        .withMessage('Phone number must contain only digits'),
    body('countryCode')
        .optional()
        .matches(/^\+[0-9]{1,4}$/)
        .withMessage('Country code must start with + and be 1-4 digits (e.g., +91)'),
    body('otp')
        .notEmpty()
        .withMessage('OTP is required')
        .matches(/^[0-9]{6}$/)
        .withMessage('OTP must be 6 digits')
];

const resendOTPValidation = [
    body('phoneNumber')
        .notEmpty()
        .withMessage('Phone number is required')
        .isLength({ min: 10, max: 10 })
        .withMessage('Phone number must be exactly 10 digits')
        .matches(/^[0-9]{10}$/)
        .withMessage('Phone number must contain only digits'),
    body('countryCode')
        .optional()
        .matches(/^\+[0-9]{1,4}$/)
        .withMessage('Country code must start with + and be 1-4 digits (e.g., +91)'),
    body('type')
        .optional()
        .isIn(['registration', 'login', 'forgot_password'])
        .withMessage('Invalid OTP type')
];

// Routes
// Unified login/register with phone number
router.post('/login-or-register', phoneLoginValidation, validate, userController.loginOrRegister);
router.get('/profile', authenticate, userController.getProfile);

// OTP Routes
router.post('/verify-otp', verifyOTPValidation, validate, userController.verifyOTP);
router.post('/resend-otp', resendOTPValidation, validate, userController.resendOTP);


router.put('/:id', authenticate, upload.single('profileImage'), userController.updateUser);
router.delete('/:id', authenticate, userController.deleteUser);

module.exports = router;

