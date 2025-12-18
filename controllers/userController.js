const User = require('../models/user');
const Role = require('../models/role');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const jwtConfig = require('../config/jwt');
const { OAuth2Client } = require('google-auth-library');
const { uploadToS3 } = require('../utils/s3');
const { logInfo, logError } = require('../utils/logger');
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

        // Create user
        const user = await User.create({
            firstName,
            lastName,
            email,
            phoneNumber,
            countryCode: finalCountryCode,
            password,
            role: defaultRole._id
        });

        // Populate role - use select to get only needed fields
        await user.populate('role', 'name permissions');

        // Generate JWT token
        const token = jwt.sign(
            { userId: user._id, email: user.email, roleId: user.role._id },
            jwtConfig.secret,
            { expiresIn: jwtConfig.expiresIn }
        );

        logInfo('User registered successfully', { userId: user._id, email: user.email });
        res.status(201).json({
            success: true,
            message: 'User registered successfully',
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
