const bcrypt = require("bcryptjs/dist/bcrypt");
const Role = require("../models/role");
const User = require("../models/user");
const jwt = require('jsonwebtoken');
const jwtConfig = require('../config/jwt');
const Developer = require('../models/developer');
const Property = require('../models/property');
const leadModal = require("../models/leadModal");
const LeadActivity = require("../models/leadActivity");
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
            projectName, developer, location, latitude, longitude, projectSize, landParcel,
            possessionDate, developerPrice, offerPrice, minGroupMembers,
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

        // Helper function to calculate discount percentage
        const calculateDiscountPercentage = (devPrice, offerPrice) => {
            if (!devPrice || !offerPrice) return "00.00%";

            const parsePriceToNumber = (priceStr) => {
                if (!priceStr) return 0;
                let priceNum = parseFloat(priceStr.replace(/[₹,\s]/g, '')) || 0;
                const priceStrLower = priceStr.toLowerCase();
                if (priceStrLower.includes('lakh') || priceStrLower.includes('l')) {
                    priceNum = priceNum * 100000;
                } else if (priceStrLower.includes('cr') || priceStrLower.includes('crore')) {
                    priceNum = priceNum * 10000000;
                }
                return priceNum;
            };

            const devPriceNum = parsePriceToNumber(devPrice);
            const offerPriceNum = parsePriceToNumber(offerPrice);

            if (devPriceNum > 0 && offerPriceNum > 0 && devPriceNum > offerPriceNum) {
                const discount = ((devPriceNum - offerPriceNum) / devPriceNum) * 100;
                return `${discount.toFixed(2)}%`;
            }
            return "00.00%";
        };

        // Calculate discount percentage
        const discountPercentage = calculateDiscountPercentage(developerPrice, offerPrice);

        // ---------- Create Property ----------
        const property = await Property.create({
            projectName,
            developer,
            location,
            latitude,
            longitude,
            projectSize,
            landParcel,
            possessionDate,
            developerPrice,
            offerPrice,
            discountPercentage,
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
            .sort({ createdAt: -1 })
            .lean();

        // Get all property IDs
        const propertyIds = properties.map(p => p._id);

        // Count joined group members for each property using aggregation
        // This counts unique leads that have joined the group (have join_group activity)
        const joinedGroupCounts = {};

        if (propertyIds.length > 0) {
            // Use aggregation to count unique leads with join_group activity per property
            const joinGroupStats = await leadModal.aggregate([
                // Match leads for these properties
                {
                    $match: {
                        propertyId: { $in: propertyIds },
                        isStatus: true
                    }
                },
                // Lookup join_group activities
                {
                    $lookup: {
                        from: 'leadactivities',
                        let: { leadId: '$_id' },
                        pipeline: [
                            {
                                $match: {
                                    $expr: {
                                        $and: [
                                            { $eq: ['$leadId', '$$leadId'] },
                                            { $eq: ['$activityType', 'join_group'] }
                                        ]
                                    }
                                }
                            }
                        ],
                        as: 'joinGroupActivities'
                    }
                },
                // Filter only leads that have join_group activity
                {
                    $match: {
                        'joinGroupActivities.0': { $exists: true }
                    }
                },
                // Group by propertyId and count unique leads
                {
                    $group: {
                        _id: '$propertyId',
                        joinedGroupCount: { $sum: 1 }
                    }
                }
            ]);

            // Convert to map for easy lookup
            joinGroupStats.forEach(stat => {
                if (stat._id) {
                    joinedGroupCounts[stat._id.toString()] = stat.joinedGroupCount;
                }
            });
        }

        // Set default count of 0 for properties without any joined group members
        propertyIds.forEach(propId => {
            const propIdStr = propId.toString();
            if (!joinedGroupCounts[propIdStr]) {
                joinedGroupCounts[propIdStr] = 0;
            }
        });

        const enhancedProperties = properties.map((property) => {
            const p = { ...property };

            p.layouts = p.layouts.map((layout) => {
                const config = p.configurations.find((c) => c.unitType === layout.configurationUnitType);
                return {
                    ...layout,
                    configuration: config || null
                };
            });

            // Add joined group count
            const propIdStr = property._id.toString();
            p.joinedGroupCount = joinedGroupCounts[propIdStr] || 0;

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
        logError('Error fetching all properties', error, { query: req.query });
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
            'projectName', 'developer', 'location', 'latitude', 'longitude', 'projectSize', 'landParcel',
            'possessionDate', 'developerPrice', 'offerPrice', 'minGroupMembers',
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

        // Calculate discount percentage if developerPrice or offerPrice is being updated
        if (updates.developerPrice || updates.offerPrice) {
            const currentProperty = await Property.findById(req.params.id).select('developerPrice offerPrice').lean();
            const devPrice = updates.developerPrice || currentProperty?.developerPrice;
            const offerPrice = updates.offerPrice || currentProperty?.offerPrice;

            const calculateDiscountPercentage = (devPrice, offerPrice) => {
                if (!devPrice || !offerPrice) return "00.00%";

                const parsePriceToNumber = (priceStr) => {
                    if (!priceStr) return 0;
                    let priceNum = parseFloat(priceStr.replace(/[₹,\s]/g, '')) || 0;
                    const priceStrLower = priceStr.toLowerCase();
                    if (priceStrLower.includes('lakh') || priceStrLower.includes('l')) {
                        priceNum = priceNum * 100000;
                    } else if (priceStrLower.includes('cr') || priceStrLower.includes('crore')) {
                        priceNum = priceNum * 10000000;
                    }
                    return priceNum;
                };

                const devPriceNum = parsePriceToNumber(devPrice);
                const offerPriceNum = parsePriceToNumber(offerPrice);

                if (devPriceNum > 0 && offerPriceNum > 0 && devPriceNum > offerPriceNum) {
                    const discount = ((devPriceNum - offerPriceNum) / devPriceNum) * 100;
                    return `${discount.toFixed(2)}%`;
                }
                return "00.00%";
            };

            updates.discountPercentage = calculateDiscountPercentage(devPrice, offerPrice);
        }

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
                select: "projectName name location relationshipManager",
                populate: { path: "relationshipManager", select: "name" }
            })
            .populate("userId", "name email phone profileImage")
            .populate("relationshipManagerId", "name email phone")
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        const formattedData = leads.map(item => ({
            leadId: item._id,
            userName: item.userId?.name,
            email: item.userId?.email,
            phone: item.userId?.phone,
            propertyName: item.propertyId?.projectName || item.propertyId?.name || 'N/A (Contact Us)',
            location: item.propertyId?.location || 'N/A',
            propertyId: item.propertyId?._id || null,
            relationshipManager: item.propertyId?.relationshipManager?.name || item.relationshipManagerId?.name || "",
            rmEmail: item.rmEmail || '',
            rmPhone: item.rmPhone || '',
            message: item.message || '',
            source: item.source || 'origin',
            date: item.createdAt.toLocaleDateString(),
            time: item.createdAt.toLocaleTimeString(),
            status: item.status || "Pending",
            visitStatus: item.visitStatus || 'not_visited',
            isContactUs: !item.propertyId // Flag to identify contact us leads
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
                select: "projectName projectId location latitude longitude possessionDate configurations amenities images relationshipManager",
                populate: {
                    path: "relationshipManager",
                    select: "name email phone"
                }
            })
            .populate({
                path: "userId",
                select: "name email phone profileImage"
            })
            .populate({
                path: "relationshipManagerId",
                select: "name email phone"
            });

        if (!lead) {
            return res.status(404).json({ success: false, message: "Lead not found" });
        }

        // Get timeline activities for this lead
        const timelineActivities = await LeadActivity.find({ leadId: lead._id })
            .populate('performedBy', 'name email phone profileImage')
            .sort({ activityDate: -1 })
            .lean();

        // Format timeline activities
        const formattedTimeline = timelineActivities.map(activity => {
            const performer = activity.performedBy || {};
            return {
                id: activity._id,
                activityType: activity.activityType,
                activityDate: activity.activityDate,
                performedBy: {
                    id: performer._id,
                    name: activity.performedByName || performer.name || 'N/A',
                    profileImage: performer.profileImage || null
                },
                description: activity.description,
                nextFollowUpDate: activity.nextFollowUpDate || null,
                visitDate: activity.visitDate || null,
                visitTime: activity.visitTime || null,
                oldStatus: activity.oldStatus || null,
                newStatus: activity.newStatus || null,
                metadata: activity.metadata || {}
            };
        });

        // Get next follow-up date (if any)
        const nextFollowUp = timelineActivities
            .filter(a => a.nextFollowUpDate && new Date(a.nextFollowUpDate) > new Date())
            .sort((a, b) => new Date(a.nextFollowUpDate) - new Date(b.nextFollowUpDate))[0];

        // Format property details (null if contact us lead)
        const property = lead.propertyId || null;
        const propertyDetails = property ? {
            id: property._id,
            projectId: property.projectId || 'N/A',
            projectName: property.projectName || 'N/A',
            location: property.location || 'N/A',
            latitude: property.latitude || null,
            longitude: property.longitude || null,
            possessionDate: property.possessionDate || null,
            configurations: property.configurations || [],
            amenities: property.amenities || [],
            images: property.images || [],
            relationshipManager: property.relationshipManager || null
        } : null;

        // Format user details
        const user = lead.userId || {};
        const userDetails = {
            id: user._id,
            name: user.name || 'N/A',
            email: user.email || 'N/A',
            phone: user.phone || 'N/A',
            profileImage: user.profileImage || null
        };

        const data = {
            leadId: lead._id,
            user: userDetails,
            property: propertyDetails,
            rmEmail: lead.rmEmail || '',
            rmPhone: lead.rmPhone || '',
            message: lead.message || '',
            status: lead.status || 'pending',
            visitStatus: lead.visitStatus || 'not_visited',
            source: lead.source || 'origin',
            createdAt: lead.createdAt,
            updatedAt: lead.updatedAt,
            timeline: formattedTimeline,
            nextFollowUp: nextFollowUp ? {
                date: nextFollowUp.nextFollowUpDate,
                formattedDate: new Date(nextFollowUp.nextFollowUpDate).toLocaleDateString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                }),
                isOverdue: new Date(nextFollowUp.nextFollowUpDate) < new Date()
            } : null
        };

        res.json({ success: true, message: "Lead details fetched successfully", data });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
};
// ===================== ADD LEAD TIMELINE ACTIVITY =====================
// @desc    Add activity to lead timeline (phone call, WhatsApp, follow-up, etc.)
// @route   POST /api/admin/lead/:leadId/activity
// @access  Private (admin/agent/rm)
exports.addLeadActivity = async (req, res) => {
    try {
        const { leadId } = req.params;
        const { activityType, description, nextFollowUpDate, visitDate, visitTime } = req.body;
        const performedBy = req.user.userId;
        const performedByName = req.user.name || 'Admin';

        // Validate lead exists
        const lead = await leadModal.findById(leadId).select('_id userId propertyId').lean();
        if (!lead) {
            return res.status(404).json({ success: false, message: "Lead not found" });
        }

        // Validate activity type
        const validActivityTypes = ['phone_call', 'whatsapp', 'email', 'visit', 'follow_up', 'join_group', 'status_update', 'remark_update'];
        if (!validActivityTypes.includes(activityType)) {
            return res.status(400).json({
                success: false,
                message: `Invalid activity type. Must be one of: ${validActivityTypes.join(', ')}`
            });
        }

        // Prepare activity data
        const activityData = {
            leadId,
            activityType,
            performedBy,
            performedByName,
            description: description || '',
            metadata: {}
        };

        // Add specific fields based on activity type
        if (activityType === 'follow_up' && nextFollowUpDate) {
            activityData.nextFollowUpDate = new Date(nextFollowUpDate);
        }

        if (activityType === 'visit') {
            if (visitDate) activityData.visitDate = new Date(visitDate);
            if (visitTime) activityData.visitTime = visitTime;
        }

        // Create timeline activity
        const activity = await LeadActivity.create(activityData);

        // If it's a follow-up, update lead's scheduleDate
        if (activityType === 'follow_up' && nextFollowUpDate) {
            await leadModal.updateOne(
                { _id: leadId },
                { scheduleDate: new Date(nextFollowUpDate) }
            );
        }

        // If it's a visit, update lead's visitStatus
        if (activityType === 'visit') {
            await leadModal.updateOne(
                { _id: leadId },
                { visitStatus: 'visited' }
            );
        }

        logInfo('Lead activity added', {
            leadId,
            activityType,
            performedBy,
            activityId: activity._id
        });

        res.status(201).json({
            success: true,
            message: "Activity added to timeline successfully",
            data: {
                activityId: activity._id,
                activityType: activity.activityType,
                activityDate: activity.activityDate
            }
        });

    } catch (error) {
        logError('Error adding lead activity', error, {
            leadId: req.params.leadId,
            performedBy: req.user?.userId
        });
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===================== UPDATE LEAD STATUS =====================
// @desc    Update lead status and add timeline activity
// @route   PUT /api/admin/lead/:leadId/status
// @access  Private (admin/agent/rm)
exports.updateLeadStatus = async (req, res) => {
    try {
        const { leadId } = req.params;
        const { status, remark } = req.body;
        const performedBy = req.user.userId;
        const performedByName = req.user.name || 'Admin';

        // Validate status
        const validStatuses = ['pending', 'approved', 'rejected'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
            });
        }

        // Get current lead
        const lead = await leadModal.findById(leadId).select('status').lean();
        if (!lead) {
            return res.status(404).json({ success: false, message: "Lead not found" });
        }

        const oldStatus = lead.status;

        // Update lead status
        const updatedLead = await leadModal.findByIdAndUpdate(
            leadId,
            {
                status,
                ...(remark ? { message: remark } : {})
            },
            { new: true }
        ).select('status message').lean();

        // Add timeline activity for status update
        await LeadActivity.create({
            leadId,
            activityType: 'status_update',
            performedBy,
            performedByName,
            description: `Status updated from ${oldStatus} to ${status}${remark ? `. Remark: ${remark}` : ''}`,
            oldStatus,
            newStatus: status,
            metadata: { remark: remark || null }
        });

        logInfo('Lead status updated', {
            leadId,
            oldStatus,
            newStatus: status,
            performedBy
        });

        res.json({
            success: true,
            message: "Lead status updated successfully",
            data: updatedLead
        });

    } catch (error) {
        logError('Error updating lead status', error, {
            leadId: req.params.leadId,
            performedBy: req.user?.userId
        });
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===================== UPDATE LEAD REMARK =====================
// @desc    Update lead remark and add timeline activity
// @route   PUT /api/admin/lead/:leadId/remark
// @access  Private (admin/agent/rm)
exports.updateLeadRemark = async (req, res) => {
    try {
        const { leadId } = req.params;
        const { remark } = req.body;
        const performedBy = req.user.userId;
        const performedByName = req.user.name || 'Admin';

        // Get current lead
        const lead = await leadModal.findById(leadId).select('message').lean();
        if (!lead) {
            return res.status(404).json({ success: false, message: "Lead not found" });
        }

        const oldRemark = lead.message || '';

        // Update lead remark
        const updatedLead = await leadModal.findByIdAndUpdate(
            leadId,
            { message: remark || '' },
            { new: true }
        ).select('message').lean();

        // Add timeline activity for remark update
        await LeadActivity.create({
            leadId,
            activityType: 'remark_update',
            performedBy,
            performedByName,
            description: `Remark updated by ${performedByName}`,
            metadata: {
                oldRemark,
                newRemark: remark || ''
            }
        });

        logInfo('Lead remark updated', {
            leadId,
            performedBy
        });

        res.json({
            success: true,
            message: "Lead remark updated successfully",
            data: updatedLead
        });

    } catch (error) {
        logError('Error updating lead remark', error, {
            leadId: req.params.leadId,
            performedBy: req.user?.userId
        });
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===================== GET LEAD TIMELINE =====================
// @desc    Get timeline activities for a lead
// @route   GET /api/admin/lead/:leadId/timeline
// @access  Private (admin/agent/rm)
exports.getLeadTimeline = async (req, res) => {
    try {
        const { leadId } = req.params;

        // Validate lead exists
        const lead = await leadModal.findById(leadId).select('_id').lean();
        if (!lead) {
            return res.status(404).json({ success: false, message: "Lead not found" });
        }

        // Get timeline activities
        const activities = await LeadActivity.find({ leadId })
            .populate('performedBy', 'name email phone profileImage')
            .sort({ activityDate: -1 })
            .lean();

        // Format timeline activities
        const formattedTimeline = activities.map(activity => {
            const performer = activity.performedBy || {};
            return {
                id: activity._id,
                activityType: activity.activityType,
                activityDate: activity.activityDate,
                formattedDate: new Date(activity.activityDate).toLocaleDateString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                }),
                performedBy: {
                    id: performer._id,
                    name: activity.performedByName || performer.name || 'N/A',
                    email: performer.email || null,
                    phone: performer.phone || null,
                    profileImage: performer.profileImage || null
                },
                description: activity.description,
                nextFollowUpDate: activity.nextFollowUpDate || null,
                visitDate: activity.visitDate || null,
                visitTime: activity.visitTime || null,
                oldStatus: activity.oldStatus || null,
                newStatus: activity.newStatus || null,
                metadata: activity.metadata || {}
            };
        });

        res.json({
            success: true,
            message: "Timeline fetched successfully",
            data: {
                leadId,
                timeline: formattedTimeline,
                totalActivities: formattedTimeline.length
            }
        });

    } catch (error) {
        logError('Error fetching lead timeline', error, { leadId: req.params.leadId });
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

        // Validate email format
        if (!email || !email.includes('@')) {
            return res.status(400).json({
                success: false,
                message: "Invalid email format"
            });
        }

        // Block personal email providers - only allow business/domain emails
        const blockedDomains = [
            'gmail.com',
            'yahoo.com',
            'hotmail.com',
            'outlook.com',
            'live.com',
            'msn.com',
            'aol.com',
            'icloud.com',
            'mail.com',
            'protonmail.com',
            'yandex.com',
            'zoho.com',
            'rediffmail.com',
            'inbox.com',
            'gmx.com'
        ];

        const emailDomain = email.split('@')[1]?.toLowerCase().trim();
        if (!emailDomain) {
            return res.status(400).json({
                success: false,
                message: "Invalid email format"
            });
        }

        // Check if email is from blocked personal email provider
        if (blockedDomains.includes(emailDomain)) {
            return res.status(400).json({
                success: false,
                message: "Personal email addresses are not allowed. Please use a business/domain email address."
            });
        }

        // Check existing user
        const exists = await User.findOne({ email }).select('email').lean();
        if (exists) {
            return res.status(400).json({
                success: false,
                message: "Email already exists"
            });
        }

        // Check valid role
        const roleExists = await Role.findById(role).select('_id name').lean();
        if (!roleExists) {
            return res.status(400).json({
                success: false,
                message: "Invalid role"
            });
        }

        // Create user
        const user = await User.create({
            name,
            email: email.toLowerCase().trim(),
            password,
            phone,
            role
        });

        // Populate role for response
        await user.populate('role', 'name permissions');

        logInfo('User created by admin', {
            userId: user._id,
            email: user.email,
            role: roleExists.name,
            createdBy: req.user?.userId
        });

        res.status(201).json({
            success: true,
            message: "User created successfully",
            data: {
                _id: user._id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                role: user.role,
                createdAt: user.createdAt
            }
        });

    } catch (error) {
        logError('Error creating user', error, {
            email: req.body.email,
            createdBy: req.user?.userId
        });
        res.status(500).json({
            success: false,
            message: error.message || "Error creating user"
        });
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

        // Domain email validation if email is being updated
        if (email) {
            // Validate email format
            if (!email.includes('@')) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid email format"
                });
            }

            // Block personal email providers - only allow business/domain emails
            const blockedDomains = [
                'gmail.com',
                'yahoo.com',
                'hotmail.com',
                'outlook.com',
                'live.com',
                'msn.com',
                'aol.com',
                'icloud.com',
                'mail.com',
                'protonmail.com',
                'yandex.com',
                'zoho.com',
                'rediffmail.com',
                'inbox.com',
                'gmx.com'
            ];

            const emailDomain = email.split('@')[1]?.toLowerCase().trim();
            if (!emailDomain) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid email format"
                });
            }

            // Check if email is from blocked personal email provider
            if (blockedDomains.includes(emailDomain)) {
                return res.status(400).json({
                    success: false,
                    message: "Personal email addresses are not allowed. Please use a business/domain email address."
                });
            }

            // Check if email already exists (excluding current user)
            const existingUser = await User.findOne({
                email: email.toLowerCase().trim(),
                _id: { $ne: req.params.id }
            }).select('email').lean();

            if (existingUser) {
                return res.status(400).json({
                    success: false,
                    message: "Email already exists"
                });
            }
        }

        // check role if provided
        if (role) {
            const roleExists = await Role.findById(role).select('_id name').lean();
            if (!roleExists) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid role"
                });
            }
        }

        // Prepare update object
        const updates = {};
        if (name) updates.name = name;
        if (email) updates.email = email.toLowerCase().trim();
        if (phone) updates.phone = phone;
        if (role) updates.role = role;

        const user = await User.findByIdAndUpdate(
            req.params.id,
            updates,
            { new: true, runValidators: true }
        ).select('-password').populate('role', 'name permissions');

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        logInfo('User updated by admin', {
            userId: user._id,
            email: user.email,
            updatedBy: req.user?.userId
        });

        res.json({
            success: true,
            message: "User updated successfully",
            data: user
        });

    } catch (error) {
        logError('Error updating user', error, {
            userId: req.params.id,
            updatedBy: req.user?.userId
        });
        res.status(500).json({
            success: false,
            message: error.message || "Error updating user"
        });
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
        // Get current month start and end dates for bookings
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

        // Dashboard Overview Cards - Run in parallel for better performance
        const [
            totalDevelopers,
            liveProjects,
            totalLeads,
            totalBookingsThisMonth
        ] = await Promise.all([
            Developer.countDocuments(),
            Property.countDocuments({ isStatus: true }),
            leadModal.countDocuments({ isStatus: true }),
            leadModal.countDocuments({
                isStatus: true,
                status: 'approved',
                createdAt: { $gte: startOfMonth, $lte: endOfMonth }
            })
        ]);

        // Recent Leads (last 5-10 leads)
        const recentLeads = await leadModal.find({ isStatus: true })
            .populate({
                path: 'userId',
                select: 'name email phone profileImage'
            })
            .populate({
                path: 'propertyId',
                select: 'projectName developerPrice offerPrice discountPercentage images'
            })
            .sort({ createdAt: -1 })
            .limit(10)
            .lean();

        // Format recent leads
        const formattedRecentLeads = recentLeads.map(lead => {
            const property = lead.propertyId || {};
            const user = lead.userId || {};

            // Get property price (use developerPrice or offerPrice)
            const priceStr = property.developerPrice || property.offerPrice || '0';
            let priceNum = parseFloat(priceStr.replace(/[₹,\s]/g, '')) || 0;
            const priceStrLower = priceStr.toLowerCase();
            if (priceStrLower.includes('lakh') || priceStrLower.includes('l')) {
                priceNum = priceNum * 100000;
            } else if (priceStrLower.includes('cr') || priceStrLower.includes('crore')) {
                priceNum = priceNum * 10000000;
            }

            const formatPrice = (amount) => {
                if (amount >= 10000000) {
                    return `₹ ${(amount / 10000000).toFixed(2)} Cr`;
                } else if (amount >= 100000) {
                    return `₹ ${(amount / 100000).toFixed(2)} Lac`;
                } else {
                    return `₹ ${amount.toLocaleString('en-IN')}`;
                }
            };

            return {
                id: lead._id,
                name: user.name || 'N/A',
                email: user.email || 'N/A',
                phone: user.phone || 'N/A',
                profileImage: user.profileImage || null,
                projectName: property.projectName || 'N/A',
                amount: formatPrice(priceNum),
                amountValue: priceNum,
                createdAt: lead.createdAt
            };
        });

        // Top Performing Projects (based on lead count)
        const topProjects = await leadModal.aggregate([
            { $match: { isStatus: true } },
            {
                $group: {
                    _id: '$propertyId',
                    leadCount: { $sum: 1 },
                    newLeads: {
                        $sum: {
                            $cond: [
                                { $gte: ['$createdAt', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)] },
                                1,
                                0
                            ]
                        }
                    }
                }
            },
            { $sort: { leadCount: -1 } },
            { $limit: 4 },
            {
                $lookup: {
                    from: 'properties',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'property'
                }
            },
            { $unwind: { path: '$property', preserveNullAndEmptyArrays: false } },
            {
                $project: {
                    _id: '$property._id',
                    projectName: '$property.projectName',
                    image: { $arrayElemAt: ['$property.images.url', 0] },
                    leadCount: 1,
                    newLeads: 1
                }
            }
        ]);

        // Format top projects
        const formattedTopProjects = topProjects.map(project => ({
            id: project._id,
            projectName: project.projectName || 'N/A',
            image: project.image || null,
            leadCount: project.leadCount || 0,
            newLeads: project.newLeads || 0,
            newLeadsFormatted: `${project.newLeads || 0} New Leads`
        }));

        // Sales Team Performance (Users with Agent or Project Manager role)
        const agentRole = await Role.findOne({ name: 'Agent' }).select('_id').lean();
        const projectManagerRole = await Role.findOne({ name: 'Project Manager' }).select('_id').lean();

        const salesTeamRoleIds = [agentRole?._id, projectManagerRole?._id].filter(Boolean);

        const salesTeamMembers = await User.find({
            role: { $in: salesTeamRoleIds }
        })
            .select('name email phone profileImage role')
            .populate('role', 'name')
            .limit(10)
            .lean();

        // Get lead stats for each sales team member
        const salesTeamPerformance = await Promise.all(salesTeamMembers.map(async (member) => {
            // Get leads assigned to this member (as relationshipManager or leadDistributionAgent)
            const totalLeads = await leadModal.countDocuments({
                $or: [
                    { relationshipManagerId: member._id },
                    { updatedBy: member._id }
                ],
                isStatus: true
            });

            // Get contacted leads (leads with visitStatus 'visited' or 'follow_up')
            const contactedLeads = await leadModal.countDocuments({
                $or: [
                    { relationshipManagerId: member._id },
                    { updatedBy: member._id }
                ],
                isStatus: true,
                visitStatus: { $in: ['visited', 'follow_up'] }
            });

            // Calculate lead contacted percentage
            const leadContactedPercentage = totalLeads > 0
                ? Math.round((contactedLeads / totalLeads) * 100)
                : 0;

            // Calculate average response time (simplified - using lead creation to first contact)
            // For now, we'll use a default or calculate from lead dates
            const responseTime = '6H'; // Can be enhanced with actual calculation

            return {
                userId: member._id,
                userName: member.name || 'N/A',
                profileImage: member.profileImage || null,
                totalLead: totalLeads,
                leadContacted: `${leadContactedPercentage}%`,
                leadContactedPercentage: leadContactedPercentage,
                responseTime: responseTime
            };
        }));

        // Group-Buy Progress
        // Target Units: Total configurations across all properties
        // Confirmed Units: Configurations with availabilityStatus 'Sold' or 'Reserved'
        const allProperties = await Property.find({ isStatus: true })
            .select('configurations')
            .lean();

        let targetUnits = 0;
        let confirmedUnits = 0;

        allProperties.forEach(property => {
            if (property.configurations && property.configurations.length > 0) {
                property.configurations.forEach(config => {
                    targetUnits++;
                    if (config.availabilityStatus === 'Sold' || config.availabilityStatus === 'Reserved') {
                        confirmedUnits++;
                    }
                });
            }
        });

        logInfo('Admin dashboard data fetched', {
            totalDevelopers,
            liveProjects,
            totalLeads,
            totalBookingsThisMonth
        });

        res.json({
            success: true,
            message: 'Admin dashboard data fetched successfully',
            data: {
                // Overview Cards
                overview: {
                    totalDevelopers,
                    liveProjects,
                    totalLeads,
                    totalBookingsThisMonth
                },
                // Recent Leads
                recentLeads: formattedRecentLeads,
                // Top Performing Projects
                topPerformingProjects: formattedTopProjects,
                // Sales Team Performance
                salesTeamPerformance: salesTeamPerformance,
                // Group-Buy Progress
                groupBuyProgress: {
                    targetUnits,
                    confirmedUnits,
                    progressPercentage: targetUnits > 0
                        ? Math.round((confirmedUnits / targetUnits) * 100)
                        : 0
                }
            }
        });

    } catch (error) {
        logError('Error fetching admin dashboard', error);
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
