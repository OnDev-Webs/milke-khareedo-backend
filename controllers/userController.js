const User = require('../models/User');
const Role = require('../models/Role');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const jwtConfig = require('../config/jwt');
const { OAuth2Client } = require('google-auth-library');
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// @desc    Register superadmin
// @route   POST /api/users/superadmin/register
// @access  Public
exports.registerSuperAdmin = async (req, res, next) => {
    try {
        const { email, password } = req.body;

        // Check if user already exists
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({
                success: false,
                message: 'User already exists with this email'
            });
        }

        // Create superadmin role with all permissions set to true
        const superAdminRole = await Role.create({
            name: 'Super Admin',
            permissions: {
                property: {
                    add: true,
                    edit: true,
                    view: true,
                    delete: true
                },
                developer: {
                    add: true,
                    edit: true,
                    view: true,
                    delete: true
                },
                crm: {
                    add: true,
                    edit: true,
                    view: true,
                    delete: true,
                    export: true
                },
                team: {
                    add: true,
                    edit: true,
                    view: true,
                    delete: true
                }
            }
        });

        // Create user with superadmin role
        const user = await User.create({
            name: 'Super Admin',
            email,
            password,
            role: superAdminRole._id
        });

        // Populate role for response
        await user.populate('role');

        // Generate JWT token
        const token = jwt.sign(
            { userId: user._id, email: user.email, roleId: user.role._id },
            jwtConfig.secret,
            { expiresIn: jwtConfig.expiresIn }
        );

        res.status(201).json({
            success: true,
            message: 'Superadmin registered successfully',
            data: {
                user: {
                    id: user._id,
                    name: user.name,
                    email: user.email,
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
        next(error);
    }
};

// @desc    Register a new user
// @route   POST /api/users/register
// @access  Public
exports.register = async (req, res, next) => {
    try {
        const { name, email, password } = req.body;

        // Check if user already exists
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({
                success: false,
                message: 'User already exists with this email'
            });
        }

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Get default role or create one if needed
        let defaultRole = await Role.findOne({ name: 'User' });
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
        }

        // Create user
        const user = await User.create({
            name,
            email,
            password,
            role: defaultRole._id
        });

        // Populate role
        await user.populate('role');

        // Generate JWT token
        const token = jwt.sign(
            { userId: user._id, email: user.email, roleId: user.role._id },
            jwtConfig.secret,
            { expiresIn: jwtConfig.expiresIn }
        );

        res.status(201).json({
            success: true,
            message: 'User registered successfully',
            data: {
                user: {
                    id: user._id,
                    name: user.name,
                    email: user.email,
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
        next(error);
    }
};

// @desc    Login user
// @route   POST /api/users/login
// @access  Public
exports.login = async (req, res, next) => {
    try {
        const { email, password } = req.body;

        // Check if user exists
        const user = await User.findOne({ email }).select('+password');
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        // Check password
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        // Populate role
        await user.populate('role');

        // Generate JWT token
        const token = jwt.sign(
            { userId: user._id, email: user.email, roleId: user.role._id },
            jwtConfig.secret,
            { expiresIn: jwtConfig.expiresIn }
        );

        res.json({
            success: true,
            message: 'Login successful',
            data: {
                user: {
                    id: user._id,
                    name: user.name,
                    email: user.email,
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
        const { email, name } = payload;

        // Check if user exists
        let user = await User.findOne({ email });
        if (!user) {
            // Get default role or create one if needed
            let defaultRole = await Role.findOne({ name: 'User' });
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
            }

            // Create new user
            user = await User.create({
                name,
                email,
                password: '',
                role: defaultRole._id
            });
        }

        // Populate role
        await user.populate('role');

        // Generate JWT token
        const token = jwt.sign(
            { userId: user._id, email: user.email, roleId: user.role._id },
            jwtConfig.secret,
            { expiresIn: jwtConfig.expiresIn }
        );

        res.json({
            success: true,
            message: 'Login successful',
            data: {
                user: {
                    id: user._id,
                    name: user.name,
                    email: user.email,
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
        next(error);
    }
};
// @desc    Get current user profile
// @route   GET /api/users/profile
// @access  Private
exports.getProfile = async (req, res, next) => {
    try {
        const user = await User.findById(req.user.userId).populate('role');
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        res.json({
            success: true,
            data: {
                user: {
                    id: user._id,
                    name: user.name,
                    email: user.email,
                    role: user.role ? {
                        id: user.role._id,
                        name: user.role.name,
                        permissions: user.role.permissions
                    } : null,
                    createdAt: user.createdAt
                }
            }
        });
    } catch (error) {
        next(error);
    }
};

// @desc    Get all users
// @route   GET /api/users
// @access  Private
exports.getAllUsers = async (req, res, next) => {
    try {
        const users = await User.find().select('-password').populate('role');
        res.json({
            success: true,
            count: users.length,
            data: users
        });
    } catch (error) {
        next(error);
    }
};

// @desc    Get user by ID
// @route   GET /api/users/:id
// @access  Private
exports.getUserById = async (req, res, next) => {
    try {
        const user = await User.findById(req.params.id).select('-password').populate('role');
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        res.json({
            success: true,
            data: user
        });
    } catch (error) {
        next(error);
    }
};

// @desc    Update user
// @route   PUT /api/users/:id
// @access  Private
exports.updateUser = async (req, res, next) => {
    try {
        const user = await User.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true, runValidators: true }
        ).select('-password').populate('role');

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        res.json({
            success: true,
            message: 'User updated successfully',
            data: user
        });
    } catch (error) {
        next(error);
    }
};

// @desc    Delete user
// @route   DELETE /api/users/:id
// @access  Private
exports.deleteUser = async (req, res, next) => {
    try {
        const user = await User.findByIdAndDelete(req.params.id);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        res.json({
            success: true,
            message: 'User deleted successfully'
        });
    } catch (error) {
        next(error);
    }
};

