const User = require('../models/user');
const Role = require('../models/role');
const OTP = require('../models/otp');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const jwtConfig = require('../config/jwt');
const { OAuth2Client } = require('google-auth-library');
const { uploadToS3 } = require('../utils/s3');
const { logInfo, logError } = require('../utils/logger');
const { generateOTP, sendOTP } = require('../utils/twilio');
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// @desc    Register a new user
// @route   POST /api/users/register
// @access  Public
exports.register = async (req, res, next) => {
    try {
        const { firstName, lastName, email, password, phoneNumber, countryCode } = req.body;

        // Validate required fields
        if (!firstName || !lastName) {
            return res.status(400).json({
                success: false,
                message: 'First name and last name are required'
            });
        }

        if (!email) {
            return res.status(400).json({
                success: false,
                message: 'Email is required'
            });
        }

        // Check if user already exists - optimize with lean() and select only email
        const existingUser = await User.findOne({ email }).select('email').lean();
        if (existingUser) {
            logInfo('Registration attempt with existing email', { email });
            return res.status(400).json({
                success: false,
                message: 'User already exists with this email'
            });
        }

        // Validate phone number
        if (!phoneNumber || phoneNumber.length !== 10) {
            return res.status(400).json({
                success: false,
                message: 'Phone number must be 10 digits'
            });
        }

        // Validate country code (default to +91 if not provided)
        const finalCountryCode = countryCode || '+91';
        if (!finalCountryCode.startsWith('+')) {
            return res.status(400).json({
                success: false,
                message: 'Country code must start with + (e.g., +91)'
            });
        }

        // Get default role or create one if needed - optimize with lean()
        let defaultRole = await Role.findOne({ name: 'User' }).lean();
        if (!defaultRole) {
            defaultRole = await Role.create({
                name: 'User',
                permissions: {
                    property: { add: false, edit: false, view: true, delete: false },
                    developer: { add: false, edit: false, view: true, delete: false },
                    crm: { add: false, edit: false, view: false, delete: false, export: false },
                    team: { add: false, edit: false, view: false, delete: false }
                }
            });
            logInfo('Default User role created');
        }

        // Create user (without phone verification)
        const user = await User.create({
            firstName,
            lastName,
            email,
            phoneNumber,
            countryCode: finalCountryCode,
            password,
            role: defaultRole._id,
            isPhoneVerified: false
        });

        // Generate OTP
        const otp = generateOTP();
        const expiresAt = new Date();
        expiresAt.setMinutes(expiresAt.getMinutes() + 10); // OTP valid for 10 minutes

        // Save OTP to database
        await OTP.create({
            userId: user._id,
            phoneNumber,
            countryCode: finalCountryCode,
            otp,
            type: 'registration',
            expiresAt
        });

        // Send OTP via Twilio SMS
        const smsResult = await sendOTP(phoneNumber, finalCountryCode, otp, 'registration');

        if (!smsResult.success) {
            logError('Failed to send OTP via Twilio', { userId: user._id, phoneNumber });
            // Still return success but note OTP sending failed
            return res.status(201).json({
                success: true,
                message: 'User registered successfully, but OTP could not be sent. Please use resend OTP.',
                data: {
                    userId: user._id,
                    email: user.email,
                    phoneNumber: user.phoneNumber,
                    requiresOTPVerification: true,
                    otpSent: false
                }
            });
        }

        logInfo('User registered successfully, OTP sent', { userId: user._id, email: user.email });
        res.status(201).json({
            success: true,
            message: 'User registered successfully. Please verify OTP sent to your phone number.',
            data: {
                userId: user._id,
                email: user.email,
                phoneNumber: user.phoneNumber,
                requiresOTPVerification: true,
                otpSent: true
            }
        });
    } catch (error) {
        logError('Error during user registration', error);
        next(error);
    }
};

// @desc    Login user
// @route   POST /api/users/login
// @access  Public
exports.login = async (req, res, next) => {
    try {
        const { email, password } = req.body;

        // Check if user exists - optimize query
        const user = await User.findOne({ email }).select('+password').populate('role', 'name permissions');
        if (!user) {
            logInfo('Login attempt with invalid email', { email });
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        // Check password
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            logInfo('Login attempt with invalid password', { email });
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        // Check if phone is verified
        if (!user.isPhoneVerified) {
            // Generate OTP for login verification
            const otp = generateOTP();
            const expiresAt = new Date();
            expiresAt.setMinutes(expiresAt.getMinutes() + 10);

            // Delete any existing login OTPs for this user
            await OTP.deleteMany({ userId: user._id, type: 'login', isVerified: false });

            // Save new OTP
            await OTP.create({
                userId: user._id,
                phoneNumber: user.phoneNumber,
                countryCode: user.countryCode,
                otp,
                type: 'login',
                expiresAt
            });

            // Send OTP via Twilio
            const smsResult = await sendOTP(user.phoneNumber, user.countryCode, otp, 'login');

            logInfo('Login OTP sent - phone not verified', { userId: user._id, email: user.email });
            return res.status(200).json({
                success: true,
                message: 'Please verify your phone number with OTP sent to your phone',
                data: {
                    requiresOTPVerification: true,
                    userId: user._id,
                    phoneNumber: user.phoneNumber,
                    otpSent: smsResult.success
                }
            });
        }

        const roleId = user.role?._id;  // optional chaining
        const roleName = user.role?.name || 'user';

        // Generate JWT token
        const token = jwt.sign(
            { userId: user._id, email: user.email, roleId, roleName },
            jwtConfig.secret,
            { expiresIn: jwtConfig.expiresIn }
        );

        logInfo('User logged in successfully', { userId: user._id, email: user.email });
        res.json({
            success: true,
            message: 'Login successful',
            data: {
                user: {
                    id: user._id,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    name: user.name,
                    email: user.email,
                    phoneNumber: user.phoneNumber,
                    countryCode: user.countryCode,
                    isPhoneVerified: user.isPhoneVerified,
                    role: user.role ? {
                        id: user.role._id,
                        name: user.role.name,
                        permissions: user.role.permissions
                    } : { id: null, name: 'user', permissions: {} }
                },
                token
            }
        });

    } catch (error) {
        logError('Error during user login', error);
        next(error);
    }
};

// @desc    Login user
// @route   POST /api/users/social-login/google
// @access  Public
exports.googleLogin = async (req, res, next) => {
    try {
        const { tokenId } = req.body;
        const ticket = await client.verifyIdToken({
            idToken: tokenId,
            audience: process.env.GOOGLE_CLIENT_ID
        });
        const payload = ticket.getPayload();
        const { email, given_name, family_name, name } = payload;

        // Split name into firstName and lastName if not provided separately
        const firstName = given_name || (name ? name.split(' ')[0] : 'User');
        const lastName = family_name || (name ? name.split(' ').slice(1).join(' ') || '' : '');

        // Check if user exists - optimize query
        let user = await User.findOne({ email }).populate('role', 'name permissions');
        if (!user) {
            // Get default role or create one if needed - optimize with lean()
            let defaultRole = await Role.findOne({ name: 'User' }).lean();
            if (!defaultRole) {
                defaultRole = await Role.create({
                    name: 'User',
                    permissions: {
                        property: { add: false, edit: false, view: true, delete: false },
                        developer: { add: false, edit: false, view: true, delete: false },
                        crm: { add: false, edit: false, view: false, delete: false, export: false },
                        team: { add: false, edit: false, view: false, delete: false }
                    }
                });
                logInfo('Default User role created during Google login');
            }

            // Create new user
            user = await User.create({
                firstName,
                lastName,
                email,
                phoneNumber: '0000000000', // Default phone number for Google login
                countryCode: '+91', // Default country code
                password: '',
                role: defaultRole._id
            });
            await user.populate('role', 'name permissions');
            logInfo('New user created via Google login', { userId: user._id, email });
        }

        // Generate JWT token
        const token = jwt.sign(
            { userId: user._id, email: user.email, roleId: user.role._id },
            jwtConfig.secret,
            { expiresIn: jwtConfig.expiresIn }
        );

        logInfo('User logged in via Google', { userId: user._id, email: user.email });
        res.json({
            success: true,
            message: 'Login successful',
            data: {
                user: {
                    id: user._id,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    name: user.name,
                    email: user.email,
                    phoneNumber: user.phoneNumber,
                    countryCode: user.countryCode,
                    role: {
                        id: user.role._id,
                        name: user.role.name,
                        permissions: user.role.permissions
                    }
                },
                token
            }
        });
    } catch (error) {
        logError('Error during Google login', error);
        next(error);
    }
};
// @desc    Get current user profile
// @route   GET /api/users/profile
// @access  Private
exports.getProfile = async (req, res, next) => {
    try {
        // Optimize query - select only needed fields and use lean()
        const user = await User.findById(req.user.userId)
            .select('-password')
            .populate('role', 'name permissions')
            .lean();
        if (!user) {
            logInfo('Profile not found', { userId: req.user.userId });
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        logInfo('Profile fetched', { userId: req.user.userId });
        res.json({
            success: true,
            data: {
                user: {
                    id: user._id,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    name: user.name,
                    email: user.email,
                    phoneNumber: user.phoneNumber,
                    countryCode: user.countryCode,
                    profileImage: user.profileImage,
                    pincode: user.pincode,
                    city: user.city,
                    state: user.state,
                    country: user.country,
                    role: user.role ? {
                        id: user.role._id,
                        name: user.role.name,
                        permissions: user.role.permissions
                    } : null,
                    createdAt: user.createdAt,
                    updatedAt: user.updatedAt
                }
            }
        });
    } catch (error) {
        logError('Error fetching profile', error, { userId: req.user.userId });
        next(error);
    }
};

// @desc    Update user
// @route   PUT /api/users/:id
// @access  Private
exports.updateUser = async (req, res, next) => {
    try {
        const userId = req.user.userId;
        const {
            firstName,
            lastName,
            email,
            phoneNumber,
            countryCode,
            pincode,
            city,
            state,
            country
        } = req.body;
        let profileImage = req.body.profileImage;

        if (req.file) {
            profileImage = await uploadToS3(req.file, 'users/profile');
        }

        const updates = {};

        // Update basic fields
        if (firstName) updates.firstName = firstName;
        if (lastName) updates.lastName = lastName;
        if (email) updates.email = email;
        if (phoneNumber) {
            // Validate phone number format
            if (phoneNumber.length !== 10) {
                return res.status(400).json({
                    success: false,
                    message: 'Phone number must be 10 digits'
                });
            }
            updates.phoneNumber = phoneNumber;
        }
        if (countryCode) {
            if (!countryCode.startsWith('+')) {
                return res.status(400).json({
                    success: false,
                    message: 'Country code must start with + (e.g., +91)'
                });
            }
            updates.countryCode = countryCode;
        }
        if (profileImage) updates.profileImage = profileImage;

        // Update profile fields (pincode, city, state, country)
        if (pincode !== undefined) updates.pincode = pincode;
        if (city !== undefined) updates.city = city;
        if (state !== undefined) updates.state = state;
        if (country !== undefined) updates.country = country;

        // If firstName or lastName is updated, name will be auto-generated by pre-save hook
        const updatedUser = await User.findByIdAndUpdate(userId, updates, {
            new: true,
            runValidators: true
        }).select('-password').populate('role', 'name permissions').lean();

        if (!updatedUser) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        logInfo('Profile updated', { userId });
        res.status(200).json({
            success: true,
            message: "Profile updated successfully",
            data: {
                user: {
                    id: updatedUser._id,
                    firstName: updatedUser.firstName,
                    lastName: updatedUser.lastName,
                    name: updatedUser.name,
                    email: updatedUser.email,
                    phoneNumber: updatedUser.phoneNumber,
                    countryCode: updatedUser.countryCode,
                    profileImage: updatedUser.profileImage,
                    pincode: updatedUser.pincode,
                    city: updatedUser.city,
                    state: updatedUser.state,
                    country: updatedUser.country,
                    role: updatedUser.role,
                    createdAt: updatedUser.createdAt,
                    updatedAt: updatedUser.updatedAt
                }
            }
        });

    } catch (error) {
        logError('Error updating profile', error, { userId: req.user.userId });
        res.status(500).json({ success: false, message: error.message });
    }
};

// @desc    Delete user
// @route   DELETE /api/users/:id
// @access  Private
exports.deleteUser = async (req, res, next) => {
    try {
        const user = await User.findByIdAndDelete(req.params.id);
        if (!user) {
            logInfo('User not found for deletion', { userId: req.params.id });
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        logInfo('User deleted', { userId: req.params.id });
        res.json({
            success: true,
            message: 'User deleted successfully'
        });
    } catch (error) {
        logError('Error deleting user', error, { userId: req.params.id });
        next(error);
    }
};

// ===================== OTP VERIFICATION APIs =====================

// @desc    Verify OTP
// @route   POST /api/users/verify-otp
// @access  Public
exports.verifyOTP = async (req, res, next) => {
    try {
        const { userId, otp, type = 'registration' } = req.body;

        if (!userId || !otp) {
            return res.status(400).json({
                success: false,
                message: 'User ID and OTP are required'
            });
        }

        // Find user
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Find valid OTP
        const otpRecord = await OTP.findOne({
            userId,
            otp,
            type,
            isVerified: false,
            expiresAt: { $gt: new Date() }
        });

        if (!otpRecord) {
            // Increment attempts if OTP exists but is wrong
            const existingOTP = await OTP.findOne({
                userId,
                type,
                isVerified: false,
                expiresAt: { $gt: new Date() }
            });

            if (existingOTP) {
                existingOTP.attempts += 1;
                await existingOTP.save();

                if (existingOTP.attempts >= 5) {
                    await OTP.deleteOne({ _id: existingOTP._id });
                    return res.status(400).json({
                        success: false,
                        message: 'Maximum OTP verification attempts exceeded. Please request a new OTP.'
                    });
                }
            }

            return res.status(400).json({
                success: false,
                message: 'Invalid or expired OTP'
            });
        }

        // Mark OTP as verified
        otpRecord.isVerified = true;
        await otpRecord.save();

        // If registration or login type, mark phone as verified
        if (type === 'registration' || type === 'login') {
            user.isPhoneVerified = true;
            user.phoneVerifiedAt = new Date();
            await user.save();
        }

        // Generate JWT token
        await user.populate('role', 'name permissions');
        const roleId = user.role?._id;
        const roleName = user.role?.name || 'user';

        const token = jwt.sign(
            { userId: user._id, email: user.email, roleId, roleName },
            jwtConfig.secret,
            { expiresIn: jwtConfig.expiresIn }
        );

        logInfo('OTP verified successfully', { userId, type });

        res.json({
            success: true,
            message: 'OTP verified successfully',
            data: {
                user: {
                    id: user._id,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    name: user.name,
                    email: user.email,
                    phoneNumber: user.phoneNumber,
                    countryCode: user.countryCode,
                    isPhoneVerified: user.isPhoneVerified,
                    role: user.role ? {
                        id: user.role._id,
                        name: user.role.name,
                        permissions: user.role.permissions
                    } : { id: null, name: 'user', permissions: {} }
                },
                token
            }
        });

    } catch (error) {
        logError('Error verifying OTP', error);
        next(error);
    }
};

// @desc    Resend OTP
// @route   POST /api/users/resend-otp
// @access  Public
exports.resendOTP = async (req, res, next) => {
    try {
        const { userId, type = 'registration' } = req.body;

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: 'User ID is required'
            });
        }

        // Find user
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Delete existing unverified OTPs of same type
        await OTP.deleteMany({
            userId,
            type,
            isVerified: false
        });

        // Generate new OTP
        const otp = generateOTP();
        const expiresAt = new Date();
        expiresAt.setMinutes(expiresAt.getMinutes() + 10);

        // Save new OTP
        await OTP.create({
            userId: user._id,
            phoneNumber: user.phoneNumber,
            countryCode: user.countryCode,
            otp,
            type,
            expiresAt
        });

        // Send OTP via Twilio
        const smsResult = await sendOTP(user.phoneNumber, user.countryCode, otp, type);

        if (!smsResult.success) {
            logError('Failed to send OTP via Twilio', { userId, phoneNumber: user.phoneNumber });
            return res.status(500).json({
                success: false,
                message: 'Failed to send OTP. Please try again later.'
            });
        }

        logInfo('OTP resent successfully', { userId, type });

        res.json({
            success: true,
            message: 'OTP sent successfully to your phone number',
            data: {
                userId: user._id,
                phoneNumber: user.phoneNumber,
                type
            }
        });

    } catch (error) {
        logError('Error resending OTP', error);
        next(error);
    }
};

// @desc    Forgot Password - Send OTP
// @route   POST /api/users/forgot-password
// @access  Public
exports.forgotPassword = async (req, res, next) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: 'Email is required'
            });
        }

        // Find user
        const user = await User.findOne({ email });
        if (!user) {
            // Don't reveal if user exists or not for security
            return res.json({
                success: true,
                message: 'If an account exists with this email, an OTP has been sent to your phone number.'
            });
        }

        // Delete existing forgot password OTPs
        await OTP.deleteMany({
            userId: user._id,
            type: 'forgot_password',
            isVerified: false
        });

        // Generate OTP
        const otp = generateOTP();
        const expiresAt = new Date();
        expiresAt.setMinutes(expiresAt.getMinutes() + 10);

        // Save OTP
        await OTP.create({
            userId: user._id,
            phoneNumber: user.phoneNumber,
            countryCode: user.countryCode,
            otp,
            type: 'forgot_password',
            expiresAt
        });

        // Send OTP via Twilio
        const smsResult = await sendOTP(user.phoneNumber, user.countryCode, otp, 'forgot_password');

        if (!smsResult.success) {
            logError('Failed to send forgot password OTP', { userId: user._id });
            return res.status(500).json({
                success: false,
                message: 'Failed to send OTP. Please try again later.'
            });
        }

        logInfo('Forgot password OTP sent', { userId: user._id, email });

        res.json({
            success: true,
            message: 'OTP sent successfully to your phone number',
            data: {
                userId: user._id
            }
        });

    } catch (error) {
        logError('Error in forgot password', error);
        next(error);
    }
};

// @desc    Reset Password after OTP verification
// @route   POST /api/users/reset-password
// @access  Public
exports.resetPassword = async (req, res, next) => {
    try {
        const { userId, otp, newPassword } = req.body;

        if (!userId || !otp || !newPassword) {
            return res.status(400).json({
                success: false,
                message: 'User ID, OTP, and new password are required'
            });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'Password must be at least 6 characters'
            });
        }

        // Find user
        const user = await User.findById(userId).select('+password');
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Verify OTP
        const otpRecord = await OTP.findOne({
            userId,
            otp,
            type: 'forgot_password',
            isVerified: false,
            expiresAt: { $gt: new Date() }
        });

        if (!otpRecord) {
            return res.status(400).json({
                success: false,
                message: 'Invalid or expired OTP'
            });
        }

        // Mark OTP as verified
        otpRecord.isVerified = true;
        await otpRecord.save();

        // Update password
        user.password = newPassword; // Will be hashed by pre-save hook
        await user.save();

        logInfo('Password reset successfully', { userId: user._id });

        res.json({
            success: true,
            message: 'Password reset successfully. Please login with your new password.'
        });

    } catch (error) {
        logError('Error resetting password', error);
        next(error);
    }
};
