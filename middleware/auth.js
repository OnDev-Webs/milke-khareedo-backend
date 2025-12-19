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

const optionalAuthenticate = (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return next(); // 🔓 no token → allow search
        }

        const token = authHeader.split(" ")[1];
        const decoded = jwt.verify(token, jwtConfig.secret);

        req.user = decoded; // { userId, role, etc }
        next();
    } catch (error) {
        next(); // ❗ invalid token → ignore & continue
    }
};

// ===================== PERMISSION-BASED AUTHORIZATION =====================
// @desc    Check if user has specific permission for a resource
// @param   {String} resource - Resource name (property, developer, crm, team, blog)
// @param   {String} action - Action name (add, edit, view, delete, export)
const checkPermission = async (req, res, next, resource, action) => {
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

        // Super Admin has all permissions
        if (user.role.name === 'Super Admin') {
            req.user.roleName = user.role.name;
            return next();
        }

        // Check if resource exists in permissions
        if (!user.role.permissions || !user.role.permissions[resource]) {
            return res.status(403).json({
                success: false,
                message: `You don't have permission to ${action} ${resource}`
            });
        }

        // Check specific permission
        const permission = user.role.permissions[resource][action];
        if (!permission) {
            return res.status(403).json({
                success: false,
                message: `You don't have permission to ${action} ${resource}`
            });
        }

        req.user.roleName = user.role.name;
        next();
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Blog Permission Middlewares
const authorizeBlogAdd = async (req, res, next) => {
    return checkPermission(req, res, next, 'blog', 'add');
};

const authorizeBlogEdit = async (req, res, next) => {
    return checkPermission(req, res, next, 'blog', 'edit');
};

const authorizeBlogView = async (req, res, next) => {
    return checkPermission(req, res, next, 'blog', 'view');
};

const authorizeBlogDelete = async (req, res, next) => {
    return checkPermission(req, res, next, 'blog', 'delete');
};

module.exports = {
    authenticate,
    authorizeAdmin,
    authorizeUser,
    authorizeSuperAdmin,
    optionalAuthenticate,
    authorizeBlogAdd,
    authorizeBlogEdit,
    authorizeBlogView,
    authorizeBlogDelete
};
