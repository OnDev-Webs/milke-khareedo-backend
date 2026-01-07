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

// @desc    Login or Register user with phone number (unified endpoint)
// @route   POST /api/users/login-or-register
// @access  Public
exports.loginOrRegister = async (req, res, next) => {
    try {
        const { phoneNumber, countryCode } = req.body;

        if (!phoneNumber || phoneNumber.length !== 10) {
            return res.status(400).json({
                success: false,
                message: 'Phone number must be 10 digits'
            });
        }

        const finalCountryCode = countryCode || '+91';
        if (!finalCountryCode.startsWith('+')) {
            return res.status(400).json({
                success: false,
                message: 'Country code must start with + (e.g., +91)'
            });
        }

        // Check if user exists by phone number
        let user = await User.findOne({ phoneNumber });

        // If user exists, check if account is active
        if (user && user.isActive === false) {
            return res.status(403).json({
                success: false,
                message: 'Your account has been deactivated. Please contact the administrator.'
            });
        }

        let defaultRole = await Role.findOne({ name: { $regex: /^user$/i } }).lean();
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

        let otpType = 'login';

        // If user doesn't exist, create a new user with temporary values
        if (!user) {
            // Generate temporary email based on phone number
            const tempEmail = `temp_${phoneNumber}@milke-khareedo.com`;

            // Check if this temp email already exists (very unlikely but handle it)
            let existingUserWithEmail = await User.findOne({ email: tempEmail });
            if (existingUserWithEmail) {
                // If somehow exists, use phone number with timestamp
                const tempEmailWithTimestamp = `temp_${phoneNumber}_${Date.now()}@milke-khareedo.com`;

                user = await User.create({
                    firstName: 'User',
                    lastName: phoneNumber.slice(-4), // Use last 4 digits as temporary lastName
                    email: tempEmailWithTimestamp,
                    phoneNumber,
                    countryCode: finalCountryCode,
                    password: `temp_${phoneNumber}_${Date.now()}`, // Temporary password
                    role: defaultRole._id,
                    isPhoneVerified: false
                });
            } else {
                user = await User.create({
                    firstName: 'User',
                    lastName: phoneNumber.slice(-4), // Use last 4 digits as temporary lastName
                    email: tempEmail,
                    phoneNumber,
                    countryCode: finalCountryCode,
                    password: `temp_${phoneNumber}_${Date.now()}`, // Temporary password
                    role: defaultRole._id,
                    isPhoneVerified: false
                });
            }

            otpType = 'registration';
            logInfo('New user created for phone-based login/register', { userId: user._id, phoneNumber });
        } else {
            logInfo('Existing user found for phone-based login', { userId: user._id, phoneNumber });
        }

        // Delete any existing unverified OTPs for this user
        await OTP.deleteMany({
            userId: user._id,
            type: otpType,
            isVerified: false
        });

        // Generate and save OTP
        const otp = generateOTP();
        const expiresAt = new Date();
        expiresAt.setMinutes(expiresAt.getMinutes() + 10);

        await OTP.create({
            userId: user._id,
            phoneNumber: user.phoneNumber,
            countryCode: user.countryCode,
            otp,
            type: otpType,
            expiresAt
        });

        // Send OTP
        const smsResult = await sendOTP(user.phoneNumber, user.countryCode, otp, otpType);

        if (!smsResult.success) {
            logError('Failed to send OTP via Twilio', { userId: user._id, phoneNumber });
            return res.status(500).json({
                success: false,
                message: 'Failed to send OTP. Please try again later.'
            });
        }

        logInfo('OTP sent successfully for login/register', { userId: user._id, phoneNumber, type: otpType });

        res.status(200).json({
            success: true,
            message: `OTP sent successfully to ${user.countryCode}${user.phoneNumber}`,
            data: {
                userId: user._id,
                phoneNumber: user.phoneNumber,
                countryCode: user.countryCode,
                type: otpType, // 'login' or 'registration'
                requiresOTPVerification: true,
                otpSent: true
            }
        });

    } catch (error) {
        logError('Error during login/register with phone', error);
        next(error);
    }
};



// @desc    Get current user profile
// @route   GET /api/users/profile
// @access  Private
exports.getProfile = async (req, res, next) => {
    try {
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

        if (firstName) updates.firstName = firstName;
        if (lastName) updates.lastName = lastName;
        if (email) updates.email = email;
        if (phoneNumber) {
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

        if (pincode !== undefined) updates.pincode = pincode;
        if (city !== undefined) updates.city = city;
        if (state !== undefined) updates.state = state;
        if (country !== undefined) updates.country = country;

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
        const { phoneNumber, countryCode, otp } = req.body;

        if (!phoneNumber || !otp) {
            return res.status(400).json({
                success: false,
                message: 'Phone number and OTP are required'
            });
        }

        if (phoneNumber.length !== 10) {
            return res.status(400).json({
                success: false,
                message: 'Phone number must be 10 digits'
            });
        }

        const finalCountryCode = countryCode || '+91';

        // Find user by phone number
        const user = await User.findOne({ phoneNumber });
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found with this phone number'
            });
        }

        // Check if user account is active
        if (user.isActive === false) {
            return res.status(403).json({
                success: false,
                message: 'Your account has been deactivated. Please contact the administrator.'
            });
        }

        const userId = user._id;

        // Find OTP record by phoneNumber and otp (without type filter)
        const otpRecord = await OTP.findOne({
            userId,
            phoneNumber,
            otp,
            isVerified: false,
            expiresAt: { $gt: new Date() }
        });

        if (!otpRecord) {
            // Check for existing unverified OTP to track attempts
            const existingOTP = await OTP.findOne({
                userId,
                phoneNumber,
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

        // Get type from OTP record
        const otpType = otpRecord.type;

        otpRecord.isVerified = true;
        await otpRecord.save();

        // Verify phone if it's registration or login
        if (otpType === 'registration' || otpType === 'login') {
            user.isPhoneVerified = true;
            user.phoneVerifiedAt = new Date();
            await user.save();
        }

        await user.populate('role', 'name permissions');
        const roleId = user.role?._id;
        const roleName = user.role?.name || 'user';

        const token = jwt.sign(
            { userId: user._id, email: user.email, roleId, roleName },
            jwtConfig.secret,
            { expiresIn: jwtConfig.expiresIn }
        );

        logInfo('OTP verified successfully', { userId, phoneNumber, type: otpType });

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
                    profileImage: user.profileImage || null,
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
        const { phoneNumber, countryCode, type = 'registration' } = req.body;

        if (!phoneNumber) {
            return res.status(400).json({
                success: false,
                message: 'Phone number is required'
            });
        }

        if (phoneNumber.length !== 10) {
            return res.status(400).json({
                success: false,
                message: 'Phone number must be 10 digits'
            });
        }

        const finalCountryCode = countryCode || '+91';

        // Find user by phone number
        const user = await User.findOne({ phoneNumber });
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found with this phone number'
            });
        }

        const userId = user._id;

        await OTP.deleteMany({
            userId,
            phoneNumber,
            type,
            isVerified: false
        });

        const otp = generateOTP();
        const expiresAt = new Date();
        expiresAt.setMinutes(expiresAt.getMinutes() + 10);

        await OTP.create({
            userId: user._id,
            phoneNumber: user.phoneNumber,
            countryCode: user.countryCode,
            otp,
            type,
            expiresAt
        });

        const smsResult = await sendOTP(user.phoneNumber, user.countryCode, otp, type);

        if (!smsResult.success) {
            logError('Failed to send OTP via Twilio', { userId, phoneNumber: user.phoneNumber });
            return res.status(500).json({
                success: false,
                message: 'Failed to send OTP. Please try again later.'
            });
        }

        logInfo('OTP resent successfully', { userId, phoneNumber, type });

        res.json({
            success: true,
            message: `OTP sent successfully to ${user.countryCode}${user.phoneNumber}`,
            data: {
                userId: user._id,
                phoneNumber: user.phoneNumber,
                countryCode: user.countryCode,
                type
            }
        });

    } catch (error) {
        logError('Error resending OTP', error);
        next(error);
    }
};

