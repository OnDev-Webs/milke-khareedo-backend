const bcrypt = require("bcryptjs/dist/bcrypt");
const Role = require("../models/role");
const User = require("../models/user");
const jwt = require('jsonwebtoken');
const jwtConfig = require('../config/jwt');
const Developer = require('../models/developer');
const Property = require('../models/property');
const leadModal = require("../models/leadModal");
const { uploadToS3 } = require("../utils/s3");
const { logInfo, logError } = require('../utils/logger');

// AUTH SECTION

// ===================== REGISTER SUPER ADMIN =====================
// @desc    Register superadmin
// @route   POST /api/admin/superadmin/register
// @access  Public
exports.registerSuperAdmin = async (req, res, next) => {
    try {
        const { email, password } = req.body;

        // Check if user already exists - optimize with lean()
        const existingUser = await User.findOne({ email }).select('email').lean();
        if (existingUser) {
            logInfo('Super admin registration attempt with existing email', { email });
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

        logInfo('Super admin registered successfully', { userId: user._id, email: user.email });
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
        logError('Error registering super admin', error);
        next(error);
    }
};
// ===================== ADMIN LOGIN =====================
// @desc    Register superadmin
// @route   POST /api/admin/admin_login
// @access  Public
exports.adminLogin = async (req, res, next) => {
    try {
        const { email, password } = req.body;

        // Check if user exists - optimize query
        const user = await User.findOne({ email }).select('+password').populate('role', 'name permissions');

        if (!user) {
            logInfo('Admin login attempt with invalid email', { email });
            return res.status(401).json({
                success: false,
                message: "Invalid credentials"
            });
        }

        // Allowed roles for admin panel
        const allowedRoles = ["admin", "Super Admin", "Project Manager", "CRM Manager"];

        if (!allowedRoles.includes(user.role.name)) {
            logInfo('Admin login attempt with unauthorized role', { email, role: user.role.name });
            return res.status(403).json({
                success: false,
                message: "You are not allowed to access admin panel"
            });
        }

        // Check password
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            logInfo('Admin login attempt with invalid password', { email });
            return res.status(401).json({
                success: false,
                message: "Invalid credentials"
            });
        }

        // Generate JWT token
        const token = jwt.sign(
            { userId: user._id, email: user.email, roleId: user.role._id },
            jwtConfig.secret,
            { expiresIn: jwtConfig.expiresIn }
        );

        logInfo('Admin logged in successfully', { userId: user._id, email: user.email, role: user.role.name });
        return res.json({
            success: true,
            message: "Admin login successful",
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
        logError('Error during admin login', error);
        next(error);
    }
};

// GET /admin/profile
exports.getAdminProfile = async (req, res) => {
    try {
        const adminId = req.user.userId;

        const admin = await User.findById(adminId).select('-password');

        if (!admin) {
            return res.status(404).json({ success: false, message: "Admin not found" });
        }

        res.status(200).json({
            success: true,
            message: "Admin profile fetched successfully",
            data: admin
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// PUT /admin/profile
exports.updateAdminProfile = async (req, res) => {
    try {
        const adminId = req.user.userId;
        const { name, email } = req.body;
        let profileImage = req.body.profileImage;

        if (req.file) {
            profileImage = await uploadToS3(req.file);
        }

        const updates = {};
        if (name) updates.name = name;
        if (email) updates.email = email;
        if (profileImage) updates.profileImage = profileImage;

        const updatedAdmin = await User.findByIdAndUpdate(adminId, updates, { new: true, runValidators: true }).select('-password');

        res.status(200).json({
            success: true,
            message: "Profile updated successfully",
            data: updatedAdmin
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// POST /change-password
exports.changePassword = async (req, res) => {
    try {
        const { oldPassword, newPassword, confirmPassword } = req.body;

        if (!oldPassword || !newPassword || !confirmPassword) {
            return res.status(400).json({ success: false, message: 'All fields are required' });
        }

        if (newPassword !== confirmPassword) {
            return res.status(400).json({ success: false, message: 'New password and confirm password do not match' });
        }

        const user = await User.findById(req.user.userId).select('+password');
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const isMatch = await bcrypt.compare(oldPassword, user.password);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: 'Old password is incorrect' });
        }

        // ❌ DO NOT HASH MANUALLY
        user.password = newPassword;

        await user.save();

        res.json({ success: true, message: 'Password changed successfully' });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
};


// USER MANAGEMENT SECTION
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


// CREATE PROPERTY SECTION

// ===================== CREATE PROPERTY =====================
exports.createProperty = async (req, res, next) => {
    try {
        let {
            projectName, developer, location, projectSize, landParcel,
            possessionDate, developerPrice, groupPrice, minGroupMembers,
            reraId, possessionStatus, description, configurations,
            highlights, amenities, layouts, connectivity,
            relationshipManager, leadDistributionAgents,
            isStatus
        } = req.body;

        // ---------- Developer Validation ----------
        const dev = await Developer.findById(developer).lean();
        if (!dev) {
            logInfo('Property creation failed - invalid developer', { developer });
            return res.status(400).json({
                success: false,
                message: "Invalid developer selected"
            });
        }

        // ---------- RM Validation (Role = project_manager) ----------
        // Fetch Role ObjectId - optimize with lean()
        const projectManagerRole = await Role.findOne({ name: "Project Manager" }).lean();

        if (!projectManagerRole) {
            return res.status(400).json({ success: false, message: "Role 'project_manager' not found" });
        }

        if (relationshipManager) {
            const rm = await User.findOne({
                _id: relationshipManager,
                role: projectManagerRole._id
            }).select('_id name').lean();
            if (!rm) {
                logInfo('Property creation failed - invalid RM', { relationshipManager });
                return res.status(400).json({
                    success: false,
                    message: "Invalid Relationship Manager (must have role 'project_manager')"
                });
            }
        }

        // ---------- Agents Validation (Role = agent) ----------
        const agentRole = await Role.findOne({ name: "Agent" }).lean();

        if (!agentRole) {
            return res.status(400).json({ success: false, message: "Role 'agent' not found" });
        }

        if (leadDistributionAgents?.length > 0) {
            const validAgents = await User.find({
                _id: { $in: leadDistributionAgents },
                role: agentRole._id
            });

            if (validAgents.length !== leadDistributionAgents.length) {
                return res.status(400).json({
                    success: false,
                    message: "All lead distribution agents must have role 'agent'"
                });
            }
        }

        // ---------- Safe JSON Parsing ----------
        const safeJSON = (value, fallback) => {
            try {
                if (!value) return fallback;
                if (typeof value === "object") return value;
                return JSON.parse(value);
            } catch {
                return fallback;
            }
        };

        configurations = safeJSON(configurations, []);
        highlights = safeJSON(highlights, []);
        amenities = safeJSON(amenities, []);
        layouts = safeJSON(layouts, []);
        connectivity = safeJSON(connectivity, {});
        leadDistributionAgents = safeJSON(leadDistributionAgents, []);

        // ---------- File Upload ----------
        let uploadedImages = [];
        let uploadedLayouts = [];
        let uploadedQrImage = null;

        if (req.files?.images) {
            for (let file of req.files.images) {
                const url = await uploadToS3(file);
                uploadedImages.push({
                    url,
                    isCover: false,
                    order: uploadedImages.length + 1
                });
            }
        }

        if (req.files?.layouts) {
            for (let i = 0; i < req.files.layouts.length; i++) {
                const url = await uploadToS3(req.files.layouts[i]);

                uploadedLayouts.push({
                    image: url,
                    configurationUnitType: layouts[i]?.configurationUnitType || null
                });
            }
        }

        if (req.files?.reraQrImage) {
            const qrFile = req.files.reraQrImage[0];
            uploadedQrImage = await uploadToS3(qrFile);
        }

        // ---------- Create Property ----------
        const property = await Property.create({
            projectName,
            developer,
            location,
            projectSize,
            landParcel,
            possessionDate,
            developerPrice,
            groupPrice,
            minGroupMembers,
            reraId,
            reraQrImage: uploadedQrImage || req.body.reraQrImage,
            possessionStatus,
            description,
            configurations,
            images: uploadedImages,
            highlights,
            amenities,
            layouts: uploadedLayouts,
            connectivity,
            relationshipManager,
            leadDistributionAgents,
            isStatus: isStatus ?? true
        });

        // ---------- Extra Return Data ----------
        // Optimize queries with lean() and run in parallel
        const [developers, relationshipManagers, agents] = await Promise.all([
            Developer.find().select("_id name").lean(),
            User.find({ role: projectManagerRole._id }).select("_id name email").lean(),
            User.find({ role: agentRole._id }).select("_id name email").lean()
        ]);

        // ---------- Response ----------
        logInfo('Property created successfully', {
            propertyId: property._id,
            projectName: property.projectName,
            developer: property.developer
        });
        res.status(201).json({
            success: true,
            message: "Property created successfully",
            data: {
                property,
                dropdownData: {
                    developers,
                    relationshipManagers,
                    agents
                }
            }
        });

    } catch (error) {
        logError('Error creating property', error, { projectName, developer, location });
        next(error);
    }
};
// ===================== GET PROPERTY =====================
exports.getAllProperties = async (req, res, next) => {
    try {
        let { page = 1, limit = 12, search, city, developer, status } = req.query;
        page = parseInt(page);
        limit = parseInt(limit);

        const filters = {};

        if (city) filters.location = city;
        if (developer) filters.developer = developer;
        if (status) filters.status = status;

        if (search) {
            filters.$or = [
                { projectName: { $regex: search, $options: 'i' } },
                { 'developer.name': { $regex: search, $options: 'i' } }
            ];
        }

        const total = await Property.countDocuments(filters);

        const properties = await Property.find(filters)
            .populate('developer', 'name')
            .populate('relationshipManager', 'name')
            .populate('leadDistributionAgents', 'name')
            .skip((page - 1) * limit)
            .limit(limit)
            .sort({ createdAt: -1 });

        const enhancedProperties = properties.map((property) => {
            const p = property.toObject();

            p.layouts = p.layouts.map((layout) => {
                const config = p.configurations.find((c) => c.unitType === layout.configurationUnitType);
                return {
                    ...layout,
                    configuration: config || null
                };
            });

            return p;
        });

        res.json({
            success: true,
            data: enhancedProperties,
            total,
            page,
            totalPages: Math.ceil(total / limit),
            count: enhancedProperties.length,
        });

    } catch (error) {
        next(error);
    }
};
// ===================== GET PROPERTY BY ID =====================
exports.getPropertyById = async (req, res, next) => {
    try {
        const property = await Property.findById(req.params.id)
            .populate('developer')
            .populate('relationshipManager')
            .populate('leadDistributionAgents');

        if (!property)
            return res.status(404).json({ success: false, message: 'Property not found' });

        // Convert to plain object
        const p = property.toObject();

        p.layouts = p.layouts.map((layout) => {
            const config = p.configurations.find(
                (c) => c.unitType === layout.configurationUnitType
            );

            return {
                ...layout,
                configuration: config || null
            };
        });

        res.json({
            success: true,
            data: p
        });

    } catch (error) {
        next(error);
    }
};
// ===================== UPDATE PROPERTY =====================
exports.updateProperty = async (req, res, next) => {
    try {
        const allowedFields = [
            'projectName', 'developer', 'location', 'projectSize', 'landParcel',
            'possessionDate', 'developerPrice', 'groupPrice', 'minGroupMembers',
            'reraId', 'possessionStatus', 'description',
            'configurations', 'highlights', 'amenities',
            'connectivity', 'relationshipManager', 'leadDistributionAgents', 'isStatus'
        ];

        const updates = {};

        // Update basic fields from req.body
        allowedFields.forEach(field => {
            if (req.body[field] !== undefined) updates[field] = req.body[field];
        });

        // Safe JSON parsing
        const safeJSON = (value, fallback) => {
            try {
                if (!value) return fallback;
                if (typeof value === 'object') return value;
                return JSON.parse(value);
            } catch {
                return fallback;
            }
        };

        updates.configurations = safeJSON(req.body.configurations, []);
        updates.highlights = safeJSON(req.body.highlights, []);
        updates.amenities = safeJSON(req.body.amenities, []);
        updates.layouts = safeJSON(req.body.layouts, []);
        updates.connectivity = safeJSON(req.body.connectivity, {});
        updates.leadDistributionAgents = safeJSON(req.body.leadDistributionAgents, []);

        // ---------- Role Validation ----------

        // Relationship Manager
        if (updates.relationshipManager) {
            const projectManagerRole = await Role.findOne({ name: "Project Manager" });
            if (!projectManagerRole) {
                return res.status(400).json({ success: false, message: "Role 'Project Manager' not found" });
            }

            const rm = await User.findOne({
                _id: updates.relationshipManager,
                role: projectManagerRole._id
            });
            if (!rm) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid Relationship Manager (must have role 'Project Manager')"
                });
            }
        }

        // Lead Distribution Agents
        if (updates.leadDistributionAgents.length > 0) {
            const agentRole = await Role.findOne({ name: "Agent" });
            if (!agentRole) {
                return res.status(400).json({ success: false, message: "Role 'Agent' not found" });
            }

            const validAgents = await User.find({
                _id: { $in: updates.leadDistributionAgents },
                role: agentRole._id
            });

            if (validAgents.length !== updates.leadDistributionAgents.length) {
                return res.status(400).json({
                    success: false,
                    message: "All lead distribution agents must have role 'Agent'"
                });
            }
        }

        // ---------- File Uploads ----------

        let uploadedImages = [];
        let uploadedLayouts = [];
        let uploadedQrImage = null;

        if (req.files?.images) {
            for (let i = 0; i < req.files.images.length; i++) {
                const url = await uploadToS3(req.files.images[i]);
                uploadedImages.push({
                    url,
                    isCover: false,
                    order: i + 1
                });
            }
            updates.images = uploadedImages;
        }

        if (req.files?.layouts) {
            const layoutsFromBody = updates.layouts;
            for (let i = 0; i < req.files.layouts.length; i++) {
                const url = await uploadToS3(req.files.layouts[i]);
                uploadedLayouts.push({
                    image: url,
                    configurationUnitType: layoutsFromBody[i]?.configurationUnitType || null
                });
            }
            updates.layouts = uploadedLayouts;
        }

        if (req.files?.reraQrImage) {
            uploadedQrImage = await uploadToS3(req.files.reraQrImage[0]);
            updates.reraQrImage = uploadedQrImage;
        }

        // ---------- Update Property ----------

        const property = await Property.findByIdAndUpdate(
            req.params.id,
            updates,
            { new: true, runValidators: true }
        );

        if (!property)
            return res.status(404).json({
                success: false,
                message: 'Property not found'
            });

        res.json({
            success: true,
            message: 'Property updated successfully',
            data: property
        });

    } catch (error) {
        logError('Error updating property', error, {
            propertyId: req.params.id,
            projectName: updates.projectName || req.body.projectName,
            developer: updates.developer || req.body.developer
        });
        next(error);
    }
};
// ===================== DELETE PROPERTY =====================
exports.deleteProperty = async (req, res, next) => {
    try {
        const deleted = await Property.findByIdAndDelete(req.params.id);
        if (!deleted)
            return res.status(404).json({ success: false, message: 'Property not found' });

        res.json({ success: true, message: 'Property deleted successfully' });

    } catch (error) {
        next(error);
    }
};

// DEVELOPER SECTION

// ===================== CREATE DEVELOPER =====================
exports.createDeveloper = async (req, res, next) => {
    try {
        let logo = null;
        if (req.file) {
            logo = await uploadToS3(req.file);
        } else if (req.body.logo) {
            logo = req.body.logo;
        }

        const {
            developerName,
            description,
            city,
            establishedYear,
            website,
            totalProjects,
            sourcingManager
        } = req.body;

        // Sourcing manager should be object, not string
        let parsedSourcingManager = sourcingManager;
        if (typeof sourcingManager === 'string') {
            try {
                parsedSourcingManager = JSON.parse(sourcingManager);
            } catch (err) {
                return res.status(400).json({ success: false, message: "Invalid sourcingManager JSON" });
            }
        }

        if (!logo || !developerName || !city || !parsedSourcingManager?.name || !parsedSourcingManager?.mobile) {
            return res.status(400).json({
                success: false,
                message: "All required fields are mandatory"
            });
        }

        const developer = await Developer.create({
            logo,
            developerName,
            description,
            city,
            establishedYear,
            website,
            totalProjects,
            sourcingManager: parsedSourcingManager
        });

        res.status(201).json({
            success: true,
            message: "Developer created successfully",
            data: developer
        });
    } catch (error) {
        next(error);
    }
};
// ===================== GET DEVELOPER =====================
exports.getAllDevelopers = async (req, res, next) => {
    try {
        const filters = {};
        if (req.query.city) filters.city = req.query.city;

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const total = await Developer.countDocuments(filters);
        const developers = await Developer.find(filters)
            .skip(skip)
            .limit(limit);

        res.json({
            success: true,
            data: developers,
            count: developers.length,
            total,
            page,
            limit,
        });
    } catch (error) {
        next(error);
    }
};
// ===================== GET DEVELOPER BY ID =====================
exports.getDeveloperById = async (req, res, next) => {
    try {
        const developer = await Developer.findById(req.params.id);
        if (!developer) return res.status(404).json({ success: false, message: 'Developer not found' });
        res.json({ success: true, data: developer });
    } catch (error) {
        next(error);
    }
};
// ===================== UPDATE DEVELOPER =====================
exports.updateDeveloper = async (req, res, next) => {
    try {
        const allowedFields = [
            'developerName',
            'description',
            'city',
            'establishedYear',
            'website',
            'totalProjects',
            'sourcingManager'
        ];

        const updates = {};

        // If new file is received → upload to S3
        if (req.file) {
            updates.logo = await uploadToS3(req.file);
        }

        // Form-data fields
        allowedFields.forEach(field => {
            if (req.body[field] !== undefined) {
                if (field === 'sourcingManager') {
                    try {
                        updates.sourcingManager = JSON.parse(req.body.sourcingManager);
                    } catch (error) {
                        return res.status(400).json({
                            success: false,
                            message: "Invalid sourcingManager format. Must be JSON string."
                        });
                    }
                } else {
                    updates[field] = req.body[field];
                }
            }
        });

        const updatedDev = await Developer.findByIdAndUpdate(
            req.params.id,
            updates,
            { new: true, runValidators: true }
        );

        if (!updatedDev) {
            return res.status(404).json({ success: false, message: "Developer not found" });
        }

        res.json({
            success: true,
            message: "Developer updated successfully",
            data: updatedDev
        });

    } catch (err) {
        next(err);
    }
};
// ===================== DELETE DEVELOPER =====================
exports.deleteDeveloper = async (req, res, next) => {
    try {
        const developer = await Developer.findByIdAndDelete(req.params.id);
        if (!developer) return res.status(404).json({ success: false, message: 'Developer not found' });
        res.json({ success: true, message: 'Developer deleted successfully' });
    } catch (error) {
        next(error);
    }
};

// LEAD MANAGEMENT SECTION 

// ===================== GET LEAD LIST =====================
// GET LEADS LIST
exports.getLeadsList = async (req, res) => {
    try {
        const filter = {};

        if (req.user.roleName.toLowerCase() === 'user') {
            filter.userId = req.user.userId;
        }

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const total = await leadModal.countDocuments();
        const leads = await leadModal.find()
            .populate({
                path: "propertyId",
                select: "name location relationshipManager",
                populate: { path: "relationshipManager", select: "name" }
            })
            .populate("userId", "name email phone")
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        const formattedData = leads.map(item => ({
            leadId: item._id,
            userName: item.userId?.name,
            email: item.userId?.email,
            phone: item.userId?.phone,
            propertyName: item.propertyId?.name,
            location: item.propertyId?.location,
            relationshipManager: item.propertyId?.relationshipManager?.name || "",
            rmEmail: item.rmEmail,
            rmPhone: item.rmPhone,
            date: item.createdAt.toLocaleDateString(),
            time: item.createdAt.toLocaleTimeString(),
            status: item.status || "Pending"
        }));

        res.json({
            success: true,
            message: "Lead list fetched successfully",
            data: formattedData,
            pagination: { total, page, limit, totalPages: Math.ceil(total / limit) }
        });

    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
// ===================== GET LEAD DETAILS =====================
exports.viewLeadDetails = async (req, res) => {
    try {
        // Admin check
        if (req.user.roleName.toLowerCase() === 'user') {
            return res.status(403).json({ success: false, message: 'Access denied, admin only' });
        }

        const { leadId } = req.params;

        const lead = await leadModal.findById(leadId)
            .populate({
                path: "propertyId",
                select: "name location possessionDate configurations amenities images relationshipManager",
                populate: {
                    path: "relationshipManager",
                    select: "name email phone"
                }
            })
            .populate({
                path: "userId",
                select: "name email phone"
            });

        if (!lead) {
            return res.status(404).json({ success: false, message: "Lead not found" });
        }

        const data = {
            leadId: lead._id,
            user: lead.userId || {},
            property: lead.propertyId || {},
            rmEmail: lead.rmEmail,
            rmPhone: lead.rmPhone,
            message: lead.message,
            status: lead.status,
            createdAt: lead.createdAt,
            updatedAt: lead.updatedAt
        };

        res.json({ success: true, message: "Lead details fetched successfully", data });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
};
// ===================== DELETE LEAD =====================
exports.deleteLead = async (req, res) => {
    try {
        // Admin check
        if (req.user.roleName.toLowerCase() === 'user') {
            return res.status(403).json({ success: false, message: 'Access denied, admin only' });
        }

        const leadId = req.params.leadId;

        const deletedLead = await leadModal.findByIdAndDelete(leadId);

        if (!deletedLead) {
            return res.status(404).json({
                success: false,
                message: "Lead not found or already deleted"
            });
        }

        res.json({
            success: true,
            message: "Lead deleted successfully"
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};



exports.getAgentRoles = async (req, res) => {
    try {
        const agentRole = await Role.findOne({ name: "Agent" });
        const roles = await User.find({ role: agentRole._id });

        res.json({
            success: true,
            count: roles.length,
            data: roles
        });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
};


exports.getRelationshipManagers = async (req, res) => {
    try {
        const project_manager = await Role.findOne({ name: "Project Manager" });
        const roles = await User.find({ role: project_manager._id });

        res.json({
            success: true,
            count: roles.length,
            data: roles
        });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
};


// ROLE SECTION 

// ===================== ADD ROLE =====================
exports.addRole = async (req, res) => {
    try {
        const { name, permissions } = req.body;

        const existing = await Role.findOne({ name });
        if (existing) {
            return res.status(400).json({
                success: false,
                message: "Role already exists"
            });
        }

        const role = await Role.create({
            name,
            permissions
        });

        res.json({
            success: true,
            message: "Role created successfully",
            data: role
        });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
};
// ===================== GET ROLE ===================== 
exports.getAllRoles = async (req, res) => {
    try {
        const roles = await Role.find();

        res.json({
            success: true,
            count: roles.length,
            data: roles
        });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
};
// ===================== GET ROLE BY ID =====================
exports.getRoleById = async (req, res) => {
    try {
        const role = await Role.findById(req.params.id);

        if (!role) {
            return res.status(404).json({
                success: false,
                message: "Role not found"
            });
        }

        res.json({
            success: true,
            data: role
        });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
};
// ===================== UPDATE ROLE =====================
exports.updateRole = async (req, res) => {
    try {
        const { name, permissions } = req.body;

        const updated = await Role.findByIdAndUpdate(
            req.params.id,
            { name, permissions },
            { new: true, runValidators: true }
        );

        if (!updated) {
            return res.status(404).json({
                success: false,
                message: "Role not found"
            });
        }

        res.json({
            success: true,
            message: "Role updated successfully",
            data: updated
        });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
};
// ===================== DELETE ROLE =====================
exports.deleteRole = async (req, res) => {
    try {
        const deleted = await Role.findByIdAndDelete(req.params.id);

        if (!deleted) {
            return res.status(404).json({
                success: false,
                message: "Role not found"
            });
        }

        res.json({
            success: true,
            message: "Role deleted successfully"
        });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
};

// ASSIGN NEW USER SECTION

// ===================== CREATE USER =====================
exports.createUser = async (req, res) => {
    try {
        const { name, email, password, phone, role } = req.body;

        // Check existing user
        const exists = await User.findOne({ email });
        if (exists) {
            return res.json({ success: false, message: "Email already exists" });
        }

        // Check valid role
        const roleExists = await Role.findById(role);
        if (!roleExists) {
            return res.json({ success: false, message: "Invalid role" });
        }

        // Create user
        const user = await User.create({
            name,
            email,
            password,
            phone,
            role
        });

        res.json({
            success: true,
            message: "User created successfully",
            data: user
        });

    } catch (error) {
        res.json({ success: false, message: error.message });
    }
};
// ===================== GET ALL USERS =====================
exports.getAllAssignUsers = async (req, res) => {
    try {
        const users = await User.find()
            .select('-password')
            .populate('role', 'name');

        res.json({
            success: true,
            count: users.length,
            data: users
        });

    } catch (error) {
        res.json({ success: false, message: error.message });
    }
};
// ===================== GET USER BY ID =====================
exports.getAssignUserById = async (req, res) => {
    try {
        const user = await User.findById(req.params.id)
            .select('-password')
            .populate('role', 'name permissions');

        if (!user) {
            return res.json({ success: false, message: "User not found" });
        }

        res.json({ success: true, data: user });

    } catch (error) {
        res.json({ success: false, message: error.message });
    }
};
// ===================== UPDATE USER =====================
exports.updateAssignUser = async (req, res) => {
    try {
        const { name, email, phone, role } = req.body;

        // check role if provided
        if (role) {
            const roleExists = await Role.findById(role);
            if (!roleExists) {
                return res.json({ success: false, message: "Invalid role" });
            }
        }

        const user = await User.findByIdAndUpdate(
            req.params.id,
            { name, email, phone, role },
            { new: true }
        ).select('-password');

        if (!user) {
            return res.json({ success: false, message: "User not found" });
        }

        res.json({
            success: true,
            message: "User updated successfully",
            data: user
        });

    } catch (error) {
        res.json({ success: false, message: error.message });
    }
};
// ===================== DELETE USER =====================
exports.deleteAssignUser = async (req, res) => {
    try {
        const deleted = await User.findByIdAndDelete(req.params.id);

        if (!deleted) {
            return res.json({ success: false, message: "User not found" });
        }

        res.json({
            success: true,
            message: "User deleted successfully"
        });

    } catch (error) {
        res.json({ success: false, message: error.message });
    }
};

// ADMIN DASHBOARD SECTION 
exports.getAdminDashboard = async (req, res, next) => {
    try {
        // Total Developers
        const totalDevelopers = await Developer.countDocuments();

        // Total Projects
        const totalProjects = await Property.countDocuments();

        // Live Projects (Active or Under Construction)
        const liveProjects = await Property.countDocuments({
            status: 'Active'
        });


        res.json({
            success: true,
            data: {
                totalDevelopers,
                totalProjects,
                liveProjects,
            }
        });
    } catch (error) {
        next(error);
    }
};

exports.getRecentLeads = async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 5;

        const filter = {};
        if (req.user.roleName?.toLowerCase() === 'user') {
            filter.userId = req.user.userId;
        }

        const leads = await leadModal.find(filter)
            .populate({
                path: "propertyId",
                select: "name projectName location relationshipManager",
                populate: { path: "relationshipManager", select: "name" }
            })
            .populate({
                path: "userId",
                select: "name email phone profileImage"
            })
            .sort({ createdAt: -1 })
            .limit(limit);

        const data = leads.map(item => ({
            leadId: item._id,
            userName: item.userId?.name || "",
            userPhone: item.userId?.phone || "",
            userProfileImage: item.userId?.profileImage || "",
            propertyName: item.propertyId?.name || "",
            projectName: item.propertyId?.projectName || "",
            location: item.propertyId?.location || "",
            relationshipManager: item.propertyId?.relationshipManager?.name || "",
            status: item.status || "Pending",
            createdAt: item.createdAt
        }));

        res.json({
            success: true,
            message: "Recent leads fetched",
            data
        });

    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.getFilteredLeads = async (req, res) => {
    try {
        const { type, fromDate, toDate, page = 1, limit = 10 } = req.query;

        const filter = {};

        // 🔐 Role based
        if (req.user.roleName?.toLowerCase() === 'user') {
            filter.userId = req.user.userId;
        }

        // 📅 Date filters
        const start = new Date();
        const end = new Date();

        if (type === 'today') {
            start.setHours(0, 0, 0, 0);
            end.setHours(23, 59, 59, 999);
            filter.createdAt = { $gte: start, $lte: end };
        }

        if (type === 'yesterday') {
            start.setDate(start.getDate() - 1);
            start.setHours(0, 0, 0, 0);
            end.setDate(end.getDate() - 1);
            end.setHours(23, 59, 59, 999);
            filter.createdAt = { $gte: start, $lte: end };
        }

        if (type === 'custom' && fromDate && toDate) {
            filter.createdAt = {
                $gte: new Date(fromDate),
                $lte: new Date(toDate)
            };
        }

        const skip = (page - 1) * limit;

        const total = await leadModal.countDocuments(filter);

        const leads = await leadModal.find(filter)
            .populate({
                path: "propertyId",
                select: "name projectName location relationshipManager",
                populate: { path: "relationshipManager", select: "name" }
            })
            .populate("userId", "name email phone")
            .sort({ createdAt: -1 }) // 🔥 latest first
            .skip(skip)
            .limit(parseInt(limit));

        const data = leads.map(item => ({
            leadId: item._id,
            userName: item.userId?.name,
            phone: item.userId?.phone,
            propertyName: item.propertyId?.name,
            projectName: item.propertyId?.projectName,
            location: item.propertyId?.location,
            relationshipManager: item.propertyId?.relationshipManager?.name || "",
            status: item.status || "Pending",
            createdAt: item.createdAt
        }));

        res.json({
            success: true,
            message: "Filtered leads fetched",
            data,
            pagination: {
                total,
                page: Number(page),
                limit: Number(limit),
                totalPages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
