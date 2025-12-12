const jwt = require('jsonwebtoken');
const jwtConfig = require('../config/jwt');
const User = require('../models/user');

// Authenticate JWT
const authenticate = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'No token provided, authorization denied'
            });
        }

        const decoded = jwt.verify(token, jwtConfig.secret);
        req.user = decoded;
        next();
    } catch (error) {
        res.status(401).json({
            success: false,
            message: 'Token is not valid'
        });
    }
};

const authorizeAdmin = async (req, res, next) => {
    try {
        const user = await User.findById(req.user.userId).populate('role');

        if (!user) {
            return res.status(401).json({ success: false, message: 'User not found' });
        }

        if (!user.role || !user.role.name) {
            return res.status(403).json({
                success: false,
                message: "Role not assigned to this user"
            });
        }

        // ❗ Allow all roles except "user"
        if (user.role.name.toLowerCase() === "user") {
            return res.status(403).json({
                success: false,
                message: "Access denied, admin only"
            });
        }

        next();
    } catch (error) {
        console.log(error);
        res.status(500).json({ success: false, message: error.message });
    }
};

const authorizeUser = async (req, res, next) => {
    try {
        const user = await User.findById(req.user.userId).populate('role');
        if (!user) {
            return res.status(401).json({ success: false, message: 'User not found' });
        }

        if (user.role?.name.toLowerCase() !== 'user') {
            return res.status(403).json({
                success: false,
                message: 'Access denied, users only'
            });
        }

        req.user.roleName = user.role.name;
        next();
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

const authorizeSuperAdmin = async (req, res, next) => {
    try {
        const user = await User.findById(req.user.userId).populate('role');

        if (!user) {
            return res.status(401).json({ success: false, message: 'User not found' });
        }

        if (!user.role || user.role.name !== 'Super Admin') {
            return res.status(403).json({
                success: false,
                message: 'Access denied, super admin only'
            });
        }

        req.user.roleName = user.role.name;
        next();
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = { authenticate, authorizeAdmin, authorizeUser, authorizeSuperAdmin };
