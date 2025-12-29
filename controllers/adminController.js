const bcrypt = require("bcryptjs/dist/bcrypt");
const mongoose = require('mongoose');
const Role = require("../models/role");
const User = require("../models/user");
const jwt = require('jsonwebtoken');
const jwtConfig = require('../config/jwt');
const Developer = require('../models/developer');
const Property = require('../models/property');
const leadModal = require("../models/leadModal");
const LeadActivity = require("../models/leadActivity");
const Notification = require("../models/notification");
const Blog = require("../models/blog");
const { uploadToS3, uploadBufferToS3 } = require("../utils/s3");
const { logInfo, logError } = require('../utils/logger');
const { sendPasswordSMS } = require("../utils/twilio");
const { Parser } = require("json2csv");

// AUTH SECTION

// ===================== REGISTER SUPER ADMIN =====================
// @desc    Register superadmin
// @route   POST /api/admin/superadmin/register
// @access  Public
exports.registerSuperAdmin = async (req, res, next) => {
    try {
        const { email, password } = req.body;

        const existingUser = await User.findOne({ email }).select('email').lean();
        if (existingUser) {
            logInfo('Super admin registration attempt with existing email', { email });
            return res.status(400).json({
                success: false,
                message: 'User already exists with this email'
            });
        }

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
                },
                blog: {
                    add: true,
                    edit: true,
                    view: true,
                    delete: true
                }
            }
        });

        const user = await User.create({
            name: 'Super Admin',
            email,
            password,
            role: superAdminRole._id
        });

        await user.populate('role');

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
// @route   POST /api/admin/login
// @access  Public
exports.adminLogin = async (req, res, next) => {
    try {
        const { email, password } = req.body;

        const user = await User.findOne({ email })
            .select('+password')
            .populate('role', 'name permissions');

        // ❌ User not found
        if (!user) {
            return res.status(401).json({
                success: false,
                message: "Invalid credentials"
            });
        }

        // ❌ Role not assigned
        if (!user.role || !user.role.name) {
            return res.status(403).json({
                success: false,
                message: "Role not assigned. Contact admin."
            });
        }

        // ❌ Block only USER role
        if (user.role.name.toLowerCase() === 'user') {
            return res.status(403).json({
                success: false,
                message: "You are not allowed to access admin panel"
            });
        }

        // ❌ Password mismatch
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({
                success: false,
                message: "Invalid credentials"
            });
        }

        // ✅ Generate JWT
        const token = jwt.sign(
            {
                userId: user._id,
                email: user.email,
                roleId: user.role._id,
                roleName: user.role.name
            },
            jwtConfig.secret,
            { expiresIn: jwtConfig.expiresIn }
        );

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
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        await User.findByIdAndUpdate(req.user.userId, { password: hashedPassword });

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

// Helper function to convert connectivity Map to object for JSON response
const convertConnectivityToObject = (connectivity) => {
    if (!connectivity) return {};
    if (connectivity instanceof Map) {
        return Object.fromEntries(connectivity);
    }
    if (typeof connectivity === 'object') {
        return connectivity;
    }
    return {};
};

// ===================== CREATE PROPERTY =====================
exports.createProperty = async (req, res, next) => {
    let {
        projectName, developer, location, latitude, longitude, projectSize, landParcel,
        possessionDate, developerPrice, offerPrice, minGroupMembers,
        reraId, possessionStatus, description, configurations,
        highlights, amenities, layouts, connectivity,
        relationshipManager, leadDistributionAgents,
        isStatus
    } = req.body;
    try {
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
        connectivity = safeJSON(connectivity, {});
        leadDistributionAgents = safeJSON(leadDistributionAgents, []);

        const layoutImagesMapping = safeJSON(req.body.layoutImagesMapping, {});
        let connectivityMap = new Map();
        if (connectivity && typeof connectivity === 'object') {
            Object.keys(connectivity).forEach(key => {
                if (Array.isArray(connectivity[key])) {
                    connectivityMap.set(key, connectivity[key]);
                }
            });
        }

        const parsePriceToNumber = (priceStr) => {
            if (!priceStr) return 0;
            if (typeof priceStr === 'number') return priceStr;
            let priceNum = parseFloat(priceStr.toString().replace(/[₹,\s]/g, '')) || 0;
            const priceStrLower = priceStr.toString().toLowerCase();
            if (priceStrLower.includes('lakh') || priceStrLower.includes('l')) {
                priceNum = priceNum * 100000;
            } else if (priceStrLower.includes('cr') || priceStrLower.includes('crore')) {
                priceNum = priceNum * 10000000;
            }
            return priceNum;
        };

        if (latitude) latitude = parseFloat(latitude);
        if (longitude) longitude = parseFloat(longitude);
        if (minGroupMembers) minGroupMembers = parseInt(minGroupMembers);
        if (possessionDate) possessionDate = new Date(possessionDate);

        if (developerPrice) developerPrice = parsePriceToNumber(developerPrice);
        if (offerPrice) offerPrice = parsePriceToNumber(offerPrice);

        let uploadedImages = [];
        let uploadedQrImage = null;

        const layoutImagesMap = new Map();


        if (req.files) {
            Object.keys(req.files).forEach(key => {
                console.log(`req.files[${key}]:`, Array.isArray(req.files[key]) ? req.files[key].length : 'single file');
            });
        }

        const dev = await Developer.findById(developer).lean();
        if (!dev) {
            logInfo('Property creation failed - invalid developer', { developer });
            return res.status(400).json({
                success: false,
                message: "Invalid developer selected"
            });
        }

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

        const agentRole = await Role.findOne({ name: "Agent" }).lean();

        if (!agentRole) {
            return res.status(400).json({ success: false, message: "Role 'agent' not found" });
        }

        if (leadDistributionAgents && Array.isArray(leadDistributionAgents) && leadDistributionAgents.length > 0) {
            const validAgentIds = leadDistributionAgents.filter(id => mongoose.Types.ObjectId.isValid(id));

            if (validAgentIds.length !== leadDistributionAgents.length) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid agent IDs provided"
                });
            }

            const validAgents = await User.find({
                _id: { $in: validAgentIds },
                role: agentRole._id
            }).select('_id').lean();

            if (validAgents.length !== leadDistributionAgents.length) {
                return res.status(400).json({
                    success: false,
                    message: "All lead distribution agents must have role 'agent'"
                });
            }
        } else if (leadDistributionAgents && !Array.isArray(leadDistributionAgents)) {
            leadDistributionAgents = [];
        }

        // Store files for background processing (don't await uploads - they'll run in background)
        const imageFiles = Array.isArray(req.files)
            ? req.files.filter(f => f.fieldname === 'images')
            : (req.files?.images ? (Array.isArray(req.files.images) ? req.files.images : [req.files.images]) : []);

        const layoutFiles = [];
        if (req.files && Array.isArray(req.files)) {
            for (const file of req.files) {
                if (file.fieldname && file.fieldname.startsWith('layout_')) {
                    layoutFiles.push({
                        file,
                        key: file.fieldname.replace('layout_', '')
                    });
                }
            }
        } else if (req.files && typeof req.files === 'object') {
            for (const [fieldName, files] of Object.entries(req.files)) {
                if (fieldName.startsWith('layout_')) {
                    const key = fieldName.replace('layout_', '');
                    const fileArray = Array.isArray(files) ? files : [files];
                    for (const file of fileArray) {
                        layoutFiles.push({ file, key });
                    }
                }
            }
        }

        // Handle RERA QR image upload (quick, single file - do it synchronously)
        if (req.files) {
            const reraFile = Array.isArray(req.files)
                ? req.files.find(f => f.fieldname === 'reraQrImage')
                : req.files.reraQrImage;

            if (reraFile) {
                try {
                    uploadedQrImage = await uploadToS3(reraFile, 'properties/rera');
                } catch (error) {
                    logError('Error uploading RERA QR image', error);
                }
            }
        }

        if (Array.isArray(configurations) && configurations.length > 0) {
            for (let configIndex = 0; configIndex < configurations.length; configIndex++) {
                const config = configurations[configIndex];

                if (config.subConfigurations) {
                    for (let subIndex = 0; subIndex < config.subConfigurations.length; subIndex++) {
                        const subConfig = config.subConfigurations[subIndex];

                        if (subConfig.price) {
                            subConfig.price = parsePriceToNumber(subConfig.price);
                        }

                        if (!subConfig.layoutPlanImages) {
                            subConfig.layoutPlanImages = [];
                        }

                        const unitTypeKey = (config.unitType || '').replace(/\s+/g, '');
                        const carpetAreaKey = Math.floor(
                            parseFloat(
                                (subConfig.carpetArea || '').toString().replace(/[^0-9.]/g, '')
                            ) || 0
                        ).toString();

                        const lookupKey = `${unitTypeKey}_${carpetAreaKey}`;


                        if (layoutImagesMap.has(lookupKey)) {
                            const images = layoutImagesMap.get(lookupKey);
                            subConfig.layoutPlanImages = images;
                        } else {
                            const altKey1 = `${configIndex}_${subIndex}`;
                            const altKey2 = `layout_${configIndex}_${subIndex}`;

                            if (layoutImagesMap.has(altKey1)) {
                                subConfig.layoutPlanImages = layoutImagesMap.get(altKey1);
                            } else if (layoutImagesMap.has(altKey2)) {
                                subConfig.layoutPlanImages = layoutImagesMap.get(altKey2);
                            } else {
                                console.log(`No layout images found for any key`);
                            }
                        }


                        if (layoutImagesMapping && layoutImagesMapping[config.unitType]) {
                            const unitTypeMapping = layoutImagesMapping[config.unitType];
                            if (unitTypeMapping[subConfig.carpetArea]) {
                                const mappedImages = Array.isArray(unitTypeMapping[subConfig.carpetArea])
                                    ? unitTypeMapping[subConfig.carpetArea]
                                    : [unitTypeMapping[subConfig.carpetArea]];
                                subConfig.layoutPlanImages = [...subConfig.layoutPlanImages, ...mappedImages];
                            }
                        }
                    }
                }
            }
        }

        // RERA QR image already handled above

        const calculateDiscountPercentage = (devPrice, offerPrice) => {
            if (!devPrice || !offerPrice) return "00.00%";
            const devPriceNum = typeof devPrice === 'number' ? devPrice : parsePriceToNumber(devPrice);
            const offerPriceNum = typeof offerPrice === 'number' ? offerPrice : parsePriceToNumber(offerPrice);
            if (devPriceNum > 0 && offerPriceNum > 0 && devPriceNum > offerPriceNum) {
                const discount = ((devPriceNum - offerPriceNum) / devPriceNum) * 100;
                return `${discount.toFixed(2)}%`;
            }
            return "00.00%";
        };

        const discountPercentage = calculateDiscountPercentage(developerPrice, offerPrice);

        // Log for debugging
        logInfo('Creating property with images', {
            uploadedImagesCount: uploadedImages.length,
            configurationsCount: configurations.length
        });

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
            configurations, // Will be updated with layout images in background
            images: [], // Will be updated in background
            highlights,
            amenities,
            connectivity: connectivityMap.size > 0 ? connectivityMap : new Map(),
            relationshipManager,
            leadDistributionAgents,
            isStatus: isStatus ?? true
        });

        // Process image uploads in background (non-blocking)
        (async () => {
            try {
                const backgroundUploadedImages = [];
                const backgroundLayoutImagesMap = new Map();

                // Upload property images in background
                if (imageFiles && imageFiles.length > 0) {
                    for (let i = 0; i < imageFiles.length; i++) {
                        const file = imageFiles[i];
                        try {
                            const url = await uploadToS3(file, 'properties/images');
                            backgroundUploadedImages.push({
                                url,
                                isCover: i === 0,
                                order: i + 1
                            });
                        } catch (error) {
                            logError('Error uploading image to S3 (background)', error, {
                                fileName: file.originalname,
                                propertyId: property._id
                            });
                        }
                    }
                }

                // Upload layout images in background
                for (const { file, key } of layoutFiles) {
                    try {
                        const url = await uploadToS3(file, 'properties/layouts');
                        if (!backgroundLayoutImagesMap.has(key)) {
                            backgroundLayoutImagesMap.set(key, []);
                        }
                        backgroundLayoutImagesMap.get(key).push(url);
                    } catch (error) {
                        logError('Error uploading layout image to S3 (background)', error, {
                            fileName: file.originalname,
                            propertyId: property._id,
                            key
                        });
                    }
                }

                // Update configurations with layout images
                if (backgroundLayoutImagesMap.size > 0 && configurations && Array.isArray(configurations)) {
                    for (let configIndex = 0; configIndex < configurations.length; configIndex++) {
                        const config = configurations[configIndex];
                        if (config.subConfigurations && Array.isArray(config.subConfigurations)) {
                            for (let subIndex = 0; subIndex < config.subConfigurations.length; subIndex++) {
                                const subConfig = config.subConfigurations[subIndex];
                                const unitTypeKey = (config.unitType || '').replace(/\s+/g, '');
                                const carpetAreaKey = Math.floor(
                                    parseFloat(
                                        (subConfig.carpetArea || '').toString().replace(/[^0-9.]/g, '')
                                    ) || 0
                                ).toString();
                                const lookupKey = `${unitTypeKey}_${carpetAreaKey}`;

                                if (backgroundLayoutImagesMap.has(lookupKey)) {
                                    subConfig.layoutPlanImages = backgroundLayoutImagesMap.get(lookupKey);
                                }
                            }
                        }
                    }
                }

                // Update property with uploaded images and configurations
                const updateData = {};
                if (backgroundUploadedImages.length > 0) {
                    updateData.images = backgroundUploadedImages;
                }
                if (backgroundLayoutImagesMap.size > 0) {
                    updateData.configurations = configurations;
                }

                if (Object.keys(updateData).length > 0) {
                    await Property.findByIdAndUpdate(property._id, updateData, { new: true });
                    logInfo('Property images updated in background', {
                        propertyId: property._id,
                        imagesCount: backgroundUploadedImages.length,
                        layoutImagesCount: backgroundLayoutImagesMap.size
                    });
                }
            } catch (error) {
                logError('Error in background image upload process', error, {
                    propertyId: property._id
                });
            }
        })();

        const createdProperty = await Property.findById(property._id)
            .populate('developer', 'developerName')
            .populate('relationshipManager', 'name email')
            .populate('leadDistributionAgents', 'name email')
            .lean();

        // Log for 
        logInfo('Fetched property after creation', {
            propertyId: property._id,
            dbImagesCount: createdProperty.images?.length || 0,
            uploadedImagesCount: uploadedImages.length,
            hasConfigurations: !!createdProperty.configurations
        });


        // Format images for response (may be empty initially, will be updated in background)
        if (createdProperty.images && Array.isArray(createdProperty.images) && createdProperty.images.length > 0) {
            createdProperty.images = createdProperty.images.map((img, idx) => {
                if (typeof img === 'string') {
                    return {
                        url: img,
                        isCover: idx === 0,
                        order: idx + 1
                    };
                }
                return {
                    url: img.url || '',
                    isCover: img.isCover !== undefined ? img.isCover : (idx === 0),
                    order: img.order || (idx + 1),
                    _id: img._id
                };
            }).filter(img => img.url && img.url.trim() !== '');
        } else {
            createdProperty.images = [];
        }

        if (configurations && Array.isArray(configurations) && configurations.length > 0) {
            createdProperty.configurations = configurations.map((config, configIdx) => {
                const dbConfig = createdProperty.configurations?.[configIdx];
                const processedConfig = {
                    unitType: config.unitType,
                    _id: config._id || dbConfig?._id,
                    subConfigurations: []
                };

                if (config.subConfigurations && Array.isArray(config.subConfigurations)) {
                    processedConfig.subConfigurations = config.subConfigurations.map((subConfig, subIdx) => {
                        const dbSubConfig = dbConfig?.subConfigurations?.[subIdx];
                        const layoutImages = Array.isArray(subConfig.layoutPlanImages)
                            ? subConfig.layoutPlanImages.filter(url => url && typeof url === 'string' && url.trim() !== '')
                            : [];


                        return {
                            carpetArea: subConfig.carpetArea,
                            price: subConfig.price, // Already converted to number
                            availabilityStatus: subConfig.availabilityStatus || 'Available',
                            layoutPlanImages: layoutImages.length > 0 ? layoutImages : (dbSubConfig?.layoutPlanImages || []),
                            _id: subConfig._id || dbSubConfig?._id
                        };
                    });
                }

                return processedConfig;
            });
        } else if (createdProperty.configurations && Array.isArray(createdProperty.configurations)) {
            createdProperty.configurations = createdProperty.configurations.map(config => {
                if (config.subConfigurations && Array.isArray(config.subConfigurations)) {
                    config.subConfigurations = config.subConfigurations.map(subConfig => {
                        if (!subConfig.layoutPlanImages || !Array.isArray(subConfig.layoutPlanImages)) {
                            subConfig.layoutPlanImages = [];
                        }
                        subConfig.layoutPlanImages = subConfig.layoutPlanImages.filter(url => url && typeof url === 'string' && url.trim() !== '');
                        return subConfig;
                    });
                }
                return config;
            });
        }

        if (createdProperty.connectivity instanceof Map) {
            createdProperty.connectivity = Object.fromEntries(createdProperty.connectivity);
        } else if (createdProperty.connectivity && typeof createdProperty.connectivity === 'object') {
        } else {
            createdProperty.connectivity = {};
        }

        const [developers, relationshipManagers, agents] = await Promise.all([
            Developer.findOne({ _id: developer }).select("_id name").lean(),
            User.find({ role: projectManagerRole._id }).select("_id name email").lean(),
            User.find({ role: agentRole._id }).select("_id name email").lean()
        ]);

        logInfo('Property created successfully', {
            propertyId: property._id,
            projectName: property.projectName,
            developer: property.developer
        });
        res.status(201).json({
            success: true,
            message: "Property created successfully",
            data: {
                property: createdProperty,
                dropdownData: {
                    developers,
                    relationshipManagers,
                    agents
                }
            }
        });

    } catch (error) {
        logError('Error creating property', error,
            {
                projectName: projectName || req.body?.projectName || 'N/A',
                developer: developer || req.body?.developer || 'N/A',
                location: location || req.body?.location || 'N/A'
            }
        );
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
            .populate('developer', 'developerName')
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

            // Ensure images are included (even if empty array)
            p.images = p.images || [];

            // Convert connectivity Map to object for JSON response
            p.connectivity = convertConnectivityToObject(p.connectivity);

            // Ensure configurations have proper structure with subConfigurations
            if (p.configurations && Array.isArray(p.configurations)) {
                p.configurations = p.configurations.map((config) => {
                    if (!config.subConfigurations || !Array.isArray(config.subConfigurations)) {
                        // Legacy format - convert to new format
                        // Helper to parse price
                        const parsePrice = (priceStr) => {
                            if (!priceStr) return 0;
                            if (typeof priceStr === 'number') return priceStr;
                            let priceNum = parseFloat(priceStr.toString().replace(/[₹,\s]/g, '')) || 0;
                            const priceStrLower = priceStr.toString().toLowerCase();
                            if (priceStrLower.includes('lakh') || priceStrLower.includes('l')) {
                                priceNum = priceNum * 100000;
                            } else if (priceStrLower.includes('cr') || priceStrLower.includes('crore')) {
                                priceNum = priceNum * 10000000;
                            }
                            return priceNum;
                        };
                        return {
                            unitType: config.unitType || '',
                            subConfigurations: [{
                                carpetArea: config.carpetArea || '',
                                price: parsePrice(config.price),
                                availabilityStatus: config.availabilityStatus || 'Available',
                                layoutPlanImages: []
                            }]
                        };
                    }
                    return config;
                });
            } else {
                p.configurations = [];
            }

            // Remove old layouts reference (layouts are now in subConfigurations)
            delete p.layouts;

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

        const p = property.toObject();

        p.connectivity = convertConnectivityToObject(p.connectivity);

        if (p.configurations && Array.isArray(p.configurations)) {
            p.configurations = p.configurations.map((config) => {
                if (!config.subConfigurations || !Array.isArray(config.subConfigurations)) {
                    const parsePrice = (priceStr) => {
                        if (!priceStr) return 0;
                        if (typeof priceStr === 'number') return priceStr;
                        let priceNum = parseFloat(priceStr.toString().replace(/[₹,\s]/g, '')) || 0;
                        const priceStrLower = priceStr.toString().toLowerCase();
                        if (priceStrLower.includes('lakh') || priceStrLower.includes('l')) {
                            priceNum = priceNum * 100000;
                        } else if (priceStrLower.includes('cr') || priceStrLower.includes('crore')) {
                            priceNum = priceNum * 10000000;
                        }
                        return priceNum;
                    };
                    return {
                        unitType: config.unitType || '',
                        subConfigurations: [{
                            carpetArea: config.carpetArea || '',
                            price: parsePrice(config.price),
                            availabilityStatus: config.availabilityStatus || 'Available',
                            layoutPlanImages: []
                        }]
                    };
                }
                return config;
            });
        } else {
            p.configurations = [];
        }

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

        allowedFields.forEach(field => {
            if (req.body[field] !== undefined) updates[field] = req.body[field];
        });

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

        const layoutImagesMapping = safeJSON(req.body.layoutImagesMapping, {});

        const parsePriceToNumber = (priceStr) => {
            if (!priceStr) return 0;
            if (typeof priceStr === 'number') return priceStr;
            let priceNum = parseFloat(priceStr.toString().replace(/[₹,\s]/g, '')) || 0;
            const priceStrLower = priceStr.toString().toLowerCase();
            if (priceStrLower.includes('lakh') || priceStrLower.includes('l')) {
                priceNum = priceNum * 100000;
            } else if (priceStrLower.includes('cr') || priceStrLower.includes('crore')) {
                priceNum = priceNum * 10000000;
            }
            return priceNum;
        };

        if (updates.configurations && Array.isArray(updates.configurations)) {
            for (let configIndex = 0; configIndex < updates.configurations.length; configIndex++) {
                const config = updates.configurations[configIndex];
                if (config.subConfigurations && Array.isArray(config.subConfigurations)) {
                    for (let subIndex = 0; subIndex < config.subConfigurations.length; subIndex++) {
                        const subConfig = config.subConfigurations[subIndex];
                        if (subConfig.price) {
                            subConfig.price = parsePriceToNumber(subConfig.price);
                        }
                    }
                }
            }
        }
        if (req.body.connectivity !== undefined) {
            const connectivityData = safeJSON(req.body.connectivity, {});
            let connectivityMap = new Map();
            if (connectivityData && typeof connectivityData === 'object') {
                Object.keys(connectivityData).forEach(key => {
                    if (Array.isArray(connectivityData[key])) {
                        connectivityMap.set(key, connectivityData[key]);
                    }
                });
            }
            updates.connectivity = connectivityMap.size > 0 ? connectivityMap : new Map();
        }
        updates.leadDistributionAgents = safeJSON(req.body.leadDistributionAgents, []);

        if (updates.developerPrice) {
            updates.developerPrice = parsePriceToNumber(updates.developerPrice);
        }
        if (updates.offerPrice) {
            updates.offerPrice = parsePriceToNumber(updates.offerPrice);
        }

        if (updates.developerPrice || updates.offerPrice) {
            const currentProperty = await Property.findById(req.params.id).select('developerPrice offerPrice').lean();
            const devPrice = updates.developerPrice !== undefined ? updates.developerPrice : (currentProperty?.developerPrice || 0);
            const offerPrice = updates.offerPrice !== undefined ? updates.offerPrice : (currentProperty?.offerPrice || 0);

            const calculateDiscountPercentage = (devPrice, offerPrice) => {
                if (!devPrice || !offerPrice) return "00.00%";
                const devPriceNum = typeof devPrice === 'number' ? devPrice : parsePriceToNumber(devPrice);
                const offerPriceNum = typeof offerPrice === 'number' ? offerPrice : parsePriceToNumber(offerPrice);
                if (devPriceNum > 0 && offerPriceNum > 0 && devPriceNum > offerPriceNum) {
                    const discount = ((devPriceNum - offerPriceNum) / devPriceNum) * 100;
                    return `${discount.toFixed(2)}%`;
                }
                return "00.00%";
            };

            updates.discountPercentage = calculateDiscountPercentage(devPrice, offerPrice);
        }

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

        if (req.files?.reraQrImage) {
            uploadedQrImage = await uploadToS3(req.files.reraQrImage[0]);
            updates.reraQrImage = uploadedQrImage;
        }


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
            .sort({ createdAt: -1 })
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

        if (req.file) {
            updates.logo = await uploadToS3(req.file);
        }

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

// ===================== GET ALL LEADS =====================

// @desc    Get all leads for logged-in user (filtered by their properties)
// @route   GET /api/admin/lead_list
// @access  Private (Admin/Agent)
exports.getLeadsList = async (req, res) => {
    try {
        const userId = req.user.userId;
        const role = req.user.roleName?.toLowerCase();
        const { page = 1, limit = 10, search } = req.query;
        let filter = { isStatus: true };

        // Add search by user name if search parameter is provided
        if (search && search.trim()) {
            const searchRegex = new RegExp(search.trim(), 'i');
            const matchingUsers = await User.find({
                name: { $regex: searchRegex }
            }).select('_id').lean();

            const matchingUserIds = matchingUsers.map(u => u._id);
            if (matchingUserIds.length > 0) {
                filter.userId = { $in: matchingUserIds };
            } else {
                // If no users match, return empty results
                return res.json({
                    success: true,
                    message: "Lead list fetched successfully",
                    data: [],
                    pagination: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 }
                });
            }
        }

        if (role !== 'admin' && role !== 'super admin') {
            const properties = await Property.find({
                isStatus: true,
                $or: [
                    { relationshipManager: userId },
                    { leadDistributionAgents: userId }
                ]
            }).select('_id').lean();

            const propertyIds = properties.map(p => p._id);

            if (role === 'project manager') {
                filter.$or = [
                    { propertyId: { $in: propertyIds } },
                    { relationshipManagerId: userId }
                ];
            }

            if (role === 'agent') {
                if (!propertyIds.length) {
                    return res.json({
                        success: true,
                        message: "Lead list fetched successfully",
                        data: [],
                        pagination: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 }
                    });
                }
                filter.propertyId = { $in: propertyIds };
            }
        }

        const skip = (page - 1) * limit;
        const total = await leadModal.countDocuments(filter);

        const leads = await leadModal.find(filter)
            .populate({
                path: "propertyId",
                select: "projectName projectId name location configurations images developerPrice offerPrice discountPercentage possessionDate minGroupMembers",
            })
            .populate("userId", "name email phoneNumber countryCode profileImage")
            .populate("relationshipManagerId", "name email phone")
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(Number(limit))
            .lean();


        const formattedData = leads.map(item => {
            const user = item.userId || {};
            const property = item.propertyId || {};
            const formatDateTime = (date) => {
                if (!date) return null;
                const d = new Date(date);
                const day = d.getDate();
                const month = d.toLocaleDateString('en-IN', { month: 'long' });
                const year = d.getFullYear();
                const time = d.toLocaleTimeString('en-IN', {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: true
                });
                return `${day} ${month}, ${year}, ${time}`;
            };

            const formatPhone = (user) => {
                if (!user.phoneNumber) return 'N/A';
                const countryCode = user.countryCode || '+91';
                const phoneDigits = user.phoneNumber.replace(/\s/g, '');
                return phoneDigits.length === 10
                    ? `${countryCode} ${phoneDigits.slice(0, 3)} ${phoneDigits.slice(3, 6)} ${phoneDigits.slice(6)}`
                    : `${countryCode} ${user.phoneNumber}`;
            };

            return {
                _id: item._id,
                userName: user.name || 'N/A',
                email: user.email || 'N/A',
                phoneNumber: formatPhone(user),
                profileImage: user.profileImage || null,
                projectId: property.projectId || 'N/A',
                status: item.status || 'lead_received',
                dateTime: formatDateTime(item.createdAt),
                createdAt: item.createdAt,
                updatedAt: item.updatedAt
            };
        });

        res.json({
            success: true,
            message: "Lead list fetched successfully",
            data: formattedData,
            pagination: { total, page: Number(page), limit: Number(limit), totalPages: Math.ceil(total / Number(limit)) }
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
};
// ===================== GET LEAD BY ID =====================
// @desc    Get detailed lead information with timeline
// @route   GET /api/admin/view_lead_list/:leadId
// @access  Private (Admin/Agent)
exports.viewLeadDetails = async (req, res) => {
    try {
        const { leadId } = req.params;
        const userId = req.user.userId;

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
                select: "name email phoneNumber countryCode profileImage"
            })
            .populate({
                path: "relationshipManagerId",
                select: "name email phone"
            })
            .lean();

        if (!lead) {
            return res.status(404).json({ success: false, message: "Lead not found" });
        }

        const timelineActivities = await LeadActivity.find({ leadId: lead._id })
            .populate('performedBy', 'name email phoneNumber countryCode profileImage')
            .sort({ activityDate: -1 })
            .lean();

        const formatTimelineDescription = (activity) => {
            const performer = activity.performedBy || {};
            const performerName = activity.performedByName || performer.name || 'Admin';
            const date = new Date(activity.activityDate);
            const formattedDate = date.toLocaleDateString('en-IN', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });

            let description = '';
            if (activity.activityType === 'phone_call') {
                description = `${formattedDate} - Phone call by ${performerName}`;
            } else if (activity.activityType === 'whatsapp') {
                description = `${formattedDate} - Whatsapp message sent by ${performerName}`;
            } else if (activity.activityType === 'email') {
                description = `${formattedDate} - Email sent by ${performerName}`;
            } else if (activity.activityType === 'visit') {
                description = `${formattedDate} - Site Visit Coordinated by ${performerName}`;
            } else if (activity.activityType === 'follow_up') {
                const followUpDate = activity.nextFollowUpDate
                    ? new Date(activity.nextFollowUpDate).toLocaleDateString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                    })
                    : '';
                description = `${formattedDate} - Follow up scheduled by ${performerName}${followUpDate ? ` for ${followUpDate}` : ''}`;
            } else if (activity.activityType === 'status_update') {
                description = `${formattedDate} - Status updated from ${activity.oldStatus || 'N/A'} to ${activity.newStatus || 'N/A'} by ${performerName}`;
            } else if (activity.activityType === 'remark_update') {
                description = `${formattedDate} - Remark updated by ${performerName}`;
            } else if (activity.activityType === 'join_group') {
                description = `${formattedDate} - Lead Received`;
            } else {
                description = activity.description || `${formattedDate} - Activity by ${performerName}`;
            }

            return {
                id: activity._id,
                activityType: activity.activityType,
                activityDate: activity.activityDate,
                formattedDate: formattedDate,
                description: description,
                performedBy: {
                    id: performer._id,
                    name: performerName,
                    profileImage: performer.profileImage || null
                },
                nextFollowUpDate: activity.nextFollowUpDate || null,
                visitDate: activity.visitDate || null,
                visitTime: activity.visitTime || null,
                oldStatus: activity.oldStatus || null,
                newStatus: activity.newStatus || null,
                metadata: activity.metadata || {}
            };
        };

        const formattedTimeline = timelineActivities.map(formatTimelineDescription);
        let nextFollowUp = null;
        if (lead.scheduleDate) {
            const scheduleDate = new Date(lead.scheduleDate);
            nextFollowUp = {
                date: scheduleDate,
                formattedDate: scheduleDate.toLocaleDateString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                }),
                isOverdue: scheduleDate < new Date()
            };
        } else {
            const upcomingFollowUp = timelineActivities
                .filter(a => a.nextFollowUpDate && new Date(a.nextFollowUpDate) > new Date())
                .sort((a, b) => new Date(a.nextFollowUpDate) - new Date(b.nextFollowUpDate))[0];

            if (upcomingFollowUp) {
                const followUpDate = new Date(upcomingFollowUp.nextFollowUpDate);
                nextFollowUp = {
                    date: followUpDate,
                    formattedDate: followUpDate.toLocaleDateString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                    }),
                    isOverdue: followUpDate < new Date()
                };
            }
        }

        let followUpNotification = null;

        if (nextFollowUp && nextFollowUp.isOverdue) {
            const icon = '⚠️';

            followUpNotification = {
                type: 'FOLLOW_UP_OVERDUE',
                severity: 'warning',
                message: `${icon} Next follow-up was scheduled on ${nextFollowUp.formattedDate} and is overdue.`
            };
        }


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

        const user = lead.userId || {};
        const formatPhone = (user) => {
            if (!user || !user.phoneNumber) return 'N/A';
            const countryCode = user.countryCode || '+91';
            const phoneDigits = user.phoneNumber.replace(/\s/g, '');
            if (phoneDigits.length === 10) {
                return `${countryCode} ${phoneDigits.slice(0, 3)} ${phoneDigits.slice(3, 6)} ${phoneDigits.slice(6)}`;
            }
            return `${countryCode} ${user.phoneNumber}`;
        };

        const formatDate = (date) => {
            const d = new Date(date);
            const day = d.getDate();
            const month = d.toLocaleDateString('en-IN', { month: 'long' });
            const year = d.getFullYear();
            const time = d.toLocaleTimeString('en-IN', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: true
            });
            return `${day} ${month}, ${year}, ${time}`;
        };

        const userDetails = {
            id: user._id,
            name: user.name || 'N/A',
            email: user.email || 'N/A',
            phoneNumber: formatPhone(user),
            profileImage: user.profileImage || null
        };

        const formatStatus = (status) => {
            const statusMap = {
                'lead_received': 'Lead Received',
                'interested': 'Interested',
                'no_response_dnp': 'No Response - Do Not Pick (DNP)',
                'unable_to_contact': 'Unable to Contact',
                'call_back_scheduled': 'Call Back Scheduled',
                'demo_discussion_ongoing': 'Demo Discussion Ongoing',
                'site_visit_coordination': 'Site Visit Coordination in Progress',
                'site_visit_confirmed': 'Site Visit Confirmed',
                'commercial_negotiation': 'Commercial Negotiation',
                'deal_closed': 'Deal Closed',
                'declined_interest': 'Declined Interest',
                'does_not_meet_requirements': 'Does Not Meet Requirements',
                'pending': 'Pending',
                'approved': 'Approved',
                'rejected': 'Rejected'
            };
            return statusMap[status] || status;
        };

        const data = {
            _id: lead._id,
            leadName: user.name || 'N/A',
            date: formatDate(lead.createdAt || lead.date),
            phoneNumber: formatPhone(user),
            profileImage: user.profileImage || null,
            projectId: property ? (property.projectId || 'N/A') : 'N/A',
            source: lead.source || 'origin',
            ipAddress: lead.ipAddress || 'N/A',
            remark: lead.message || '',
            status: formatStatus(lead.status || 'lead_received'),
            statusValue: lead.status || 'lead_received',
            visitStatus: lead.visitStatus || 'not_visited',
            user: userDetails,
            property: propertyDetails,
            rmEmail: lead.rmEmail || '',
            rmPhone: lead.rmPhone || '',
            createdAt: lead.createdAt,
            updatedAt: lead.updatedAt,
            timeline: formattedTimeline,
            nextFollowUp: nextFollowUp,
            followUpNotification: followUpNotification
        };

        logInfo('Lead details fetched', { leadId, userId });

        res.json({ success: true, message: "Lead details fetched successfully", data });

    } catch (error) {
        logError('Error fetching lead details', error, { leadId: req.params.leadId, userId: req.user?.userId });
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.exportLeadDetailsCSV = async (req, res) => {
    try {
        const { leadId } = req.params;

        const lead = await leadModal.findById(leadId)
            .populate({
                path: "propertyId",
                populate: { path: "relationshipManager", select: "name email phone" }
            })
            .populate("userId", "name email phoneNumber countryCode")
            .populate("relationshipManagerId", "name email phone")
            .lean();

        if (!lead) {
            return res.status(404).json({ success: false, message: "Lead not found" });
        }

        const timeline = await LeadActivity.find({ leadId })
            .populate("performedBy", "name email")
            .sort({ activityDate: -1 })
            .lean();

        const formatPhone = (user) => user?.phoneNumber ? `${user.countryCode || '+91'} ${user.phoneNumber}` : 'N/A';

        const formatDate = (date) => date ? new Date(date).toLocaleString('en-IN') : 'N/A';

        const csvRow = {
            Lead_ID: lead._id,
            Lead_Status: lead.status,
            Lead_Source: lead.source || 'N/A',
            Created_At: formatDate(lead.createdAt),

            User_Name: lead.userId?.name || 'N/A',
            User_Email: lead.userId?.email || 'N/A',
            User_Phone: formatPhone(lead.userId),

            Project_ID: lead.propertyId?.projectId || 'N/A',
            Project_Name: lead.propertyId?.projectName || 'N/A',
            Location: lead.propertyId?.location || 'N/A',
            Possession_Date: formatDate(lead.propertyId?.possessionDate),

            RM_Name: lead.propertyId?.relationshipManager?.name || 'N/A',
            RM_Email: lead.propertyId?.relationshipManager?.email || 'N/A',
            RM_Phone: lead.propertyId?.relationshipManager?.phone || 'N/A',

            Amenities: (lead.propertyId?.amenities || []).join(' | '),
            Configurations: (lead.propertyId?.configurations || []).map(cfg => {
                if (typeof cfg === 'number') {
                    if (cfg >= 10000000) return `₹ ${(cfg / 10000000).toFixed(2)} Cr`;
                    if (cfg >= 100000) return `₹ ${(cfg / 100000).toFixed(2)} Lakh`;
                    return `₹ ${cfg}`;
                }

                const bhk = cfg.unitType || cfg.bhk || '';
                const area = cfg.area || cfg.size || '';
                const price = cfg.price
                    ? (cfg.price >= 10000000
                        ? `₹ ${(cfg.price / 10000000).toFixed(2)} Cr`
                        : `₹ ${(cfg.price / 100000).toFixed(2)} Lakh`)
                    : '';

                return [bhk, area, price].filter(Boolean).join(' - ');
            }).join(' | '),

            Remark: lead.message || '',
            IP_Address: lead.ipAddress || 'N/A',

            Timeline: JSON.stringify(
                timeline.map(t => ({
                    type: t.activityType,
                    by: t.performedBy?.name || 'System',
                    date: formatDate(t.activityDate),
                    oldStatus: t.oldStatus || '',
                    newStatus: t.newStatus || '',
                }))
            )
        };
        const fields = Object.keys(csvRow);
        const parser = new Parser({ fields });
        const csv = parser.parse([csvRow]);
        res.header('Content-Type', 'text/csv');
        res.attachment(`lead_${leadId}_details.csv`);
        res.send(csv);
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===================== EXPORT ALL LEADS TO CSV =====================
// @desc    Export all leads data with timeline to CSV and upload to S3
// @route   GET /api/admin/export_all_leads_csv
// @access  Private (Admin/Agent)
exports.exportAllLeadsCSV = async (req, res) => {
    try {
        const userId = req.user.userId;
        const role = req.user.roleName?.toLowerCase();
        const { search } = req.query;
        let filter = { isStatus: true };

        // Add search by user name if search parameter is provided
        if (search && search.trim()) {
            const searchRegex = new RegExp(search.trim(), 'i');
            const matchingUsers = await User.find({
                name: { $regex: searchRegex }
            }).select('_id').lean();

            const matchingUserIds = matchingUsers.map(u => u._id);
            if (matchingUserIds.length > 0) {
                filter.userId = { $in: matchingUserIds };
            } else {
                return res.json({
                    success: true,
                    message: "No leads found for export",
                    csvUrl: null,
                    totalLeads: 0
                });
            }
        }

        // Apply role-based filters
        if (role !== 'admin' && role !== 'super admin') {
            const properties = await Property.find({
                isStatus: true,
                $or: [
                    { relationshipManager: userId },
                    { leadDistributionAgents: userId }
                ]
            }).select('_id').lean();

            const propertyIds = properties.map(p => p._id);

            if (role === 'project manager') {
                filter.$or = [
                    { propertyId: { $in: propertyIds } },
                    { relationshipManagerId: userId }
                ];
            }

            if (role === 'agent') {
                if (!propertyIds.length) {
                    return res.json({
                        success: true,
                        message: "No leads found for export",
                        csvUrl: null,
                        totalLeads: 0
                    });
                }
                filter.propertyId = { $in: propertyIds };
            }
        }

        // Get all leads without pagination
        const leads = await leadModal.find(filter)
            .populate({
                path: "propertyId",
                select: "projectName projectId location possessionDate configurations amenities relationshipManager",
                populate: {
                    path: "relationshipManager",
                    select: "name email phone"
                }
            })
            .populate("userId", "name email phoneNumber countryCode profileImage")
            .populate("relationshipManagerId", "name email phone")
            .sort({ createdAt: -1 })
            .lean();

        if (!leads || leads.length === 0) {
            return res.json({
                success: true,
                message: "No leads found for export",
                csvUrl: null,
                totalLeads: 0
            });
        }

        // Get all lead IDs to fetch timelines in batch
        const leadIds = leads.map(lead => lead._id);
        const allTimelines = await LeadActivity.find({ leadId: { $in: leadIds } })
            .populate("performedBy", "name email")
            .sort({ activityDate: -1 })
            .lean();

        // Group timelines by leadId
        const timelinesByLeadId = {};
        allTimelines.forEach(activity => {
            const leadIdStr = activity.leadId.toString();
            if (!timelinesByLeadId[leadIdStr]) {
                timelinesByLeadId[leadIdStr] = [];
            }
            timelinesByLeadId[leadIdStr].push(activity);
        });

        // Helper functions
        const formatPhone = (user) => {
            if (!user || !user.phoneNumber) return 'N/A';
            const countryCode = user.countryCode || '+91';
            const phoneDigits = user.phoneNumber.replace(/\s/g, '');
            if (phoneDigits.length === 10) {
                return `${countryCode} ${phoneDigits.slice(0, 3)} ${phoneDigits.slice(3, 6)} ${phoneDigits.slice(6)}`;
            }
            return `${countryCode} ${user.phoneNumber}`;
        };

        const formatDate = (date) => {
            if (!date) return 'N/A';
            return new Date(date).toLocaleString('en-IN');
        };

        const formatStatus = (status) => {
            const statusMap = {
                'lead_received': 'Lead Received',
                'interested': 'Interested',
                'no_response_dnp': 'No Response - Do Not Pick (DNP)',
                'unable_to_contact': 'Unable to Contact',
                'call_back_scheduled': 'Call Back Scheduled',
                'demo_discussion_ongoing': 'Demo Discussion Ongoing',
                'site_visit_coordination': 'Site Visit Coordination in Progress',
                'site_visit_confirmed': 'Site Visit Confirmed',
                'commercial_negotiation': 'Commercial Negotiation',
                'deal_closed': 'Deal Closed',
                'declined_interest': 'Declined Interest',
                'does_not_meet_requirements': 'Does Not Meet Requirements',
                'pending': 'Pending',
                'approved': 'Approved',
                'rejected': 'Rejected'
            };
            return statusMap[status] || status;
        };

        // Format data for CSV
        const csvData = leads.map(lead => {
            const user = lead.userId || {};
            const property = lead.propertyId || {};
            const timeline = timelinesByLeadId[lead._id.toString()] || [];

            // Format timeline activities
            const timelineFormatted = timeline.map(t => {
                const activityInfo = {
                    type: t.activityType || 'N/A',
                    performedBy: t.performedBy?.name || 'System',
                    date: formatDate(t.activityDate),
                    oldStatus: t.oldStatus || '',
                    newStatus: t.newStatus || '',
                    description: t.description || ''
                };
                return `${activityInfo.type} by ${activityInfo.performedBy} on ${activityInfo.date}${activityInfo.oldStatus && activityInfo.newStatus ? ` (${activityInfo.oldStatus} → ${activityInfo.newStatus})` : ''}`;
            }).join(' | ');

            // Format configurations
            const configurationsFormatted = (property.configurations || []).map(cfg => {
                if (typeof cfg === 'number') {
                    if (cfg >= 10000000) return `₹ ${(cfg / 10000000).toFixed(2)} Cr`;
                    if (cfg >= 100000) return `₹ ${(cfg / 100000).toFixed(2)} Lakh`;
                    return `₹ ${cfg}`;
                }

                const bhk = cfg.unitType || cfg.bhk || '';
                const area = cfg.area || cfg.size || cfg.carpetArea || '';
                const price = cfg.price
                    ? (cfg.price >= 10000000
                        ? `₹ ${(cfg.price / 10000000).toFixed(2)} Cr`
                        : `₹ ${(cfg.price / 100000).toFixed(2)} Lakh`)
                    : '';

                return [bhk, area, price].filter(Boolean).join(' - ');
            }).join(' | ');

            return {
                Lead_ID: lead._id.toString(),
                Lead_Status: formatStatus(lead.status || 'lead_received'),
                Lead_Status_Value: lead.status || 'lead_received',
                Lead_Source: lead.source || 'origin',
                Created_At: formatDate(lead.createdAt),
                Updated_At: formatDate(lead.updatedAt),
                Visit_Status: lead.visitStatus || 'not_visited',

                User_Name: user.name || 'N/A',
                User_Email: user.email || 'N/A',
                User_Phone: formatPhone(user),
                User_Profile_Image: user.profileImage || 'N/A',

                Project_ID: property.projectId || 'N/A',
                Project_Name: property.projectName || 'N/A',
                Location: property.location || 'N/A',
                Possession_Date: formatDate(property.possessionDate),

                RM_Name: property.relationshipManager?.name || lead.relationshipManagerId?.name || 'N/A',
                RM_Email: property.relationshipManager?.email || lead.relationshipManagerId?.email || 'N/A',
                RM_Phone: property.relationshipManager?.phone || lead.relationshipManagerId?.phone || 'N/A',

                Amenities: (property.amenities || []).join(' | '),
                Configurations: configurationsFormatted,

                Remark: lead.message || '',
                IP_Address: lead.ipAddress || 'N/A',
                RM_Email_Direct: lead.rmEmail || '',
                RM_Phone_Direct: lead.rmPhone || '',

                Timeline_Count: timeline.length,
                Timeline_Activities: timelineFormatted || 'No activities'
            };
        });

        // Generate CSV
        const fields = Object.keys(csvData[0]);
        const parser = new Parser({ fields });
        const csv = parser.parse(csvData);

        // Upload CSV to S3
        const fileName = `all_leads_export_${Date.now()}.csv`;
        const csvUrl = await uploadBufferToS3(
            Buffer.from(csv, 'utf-8'),
            fileName,
            'leads/exports',
            'text/csv'
        );

        logInfo('All leads exported to CSV', { userId, totalLeads: leads.length, csvUrl });

        res.json({
            success: true,
            message: "Leads exported successfully",
            csvUrl: csvUrl,
            totalLeads: leads.length,
            exportedAt: new Date().toISOString()
        });

    } catch (error) {
        logError('Error exporting all leads to CSV', error, { userId: req.user?.userId });
        res.status(500).json({ success: false, message: error.message });
    }
};

// Helper function to create notifications for relevant users
const createNotification = async (leadId, notificationType, source, sourceId, title, message, metadata = {}) => {
    try {
        const lead = await leadModal.findById(leadId)
            .populate('propertyId', 'relationshipManager leadDistributionAgents projectName projectId')
            .populate('userId', 'name')
            .lean();

        if (!lead || !lead.propertyId) {
            return;
        }

        const property = lead.propertyId;
        const leadUser = lead.userId || {};

        const recipients = [];

        if (property.relationshipManager) {
            recipients.push(property.relationshipManager);
        }

        if (property.leadDistributionAgents && Array.isArray(property.leadDistributionAgents)) {
            recipients.push(...property.leadDistributionAgents);
        }

        const uniqueRecipients = [...new Set(recipients.map(r => r.toString()))];

        const notificationPromises = uniqueRecipients.map(userId => {
            return Notification.create({
                userId,
                leadId,
                propertyId: property._id,
                notificationType,
                title,
                message,
                source,
                sourceId,
                metadata: {
                    projectName: property.projectName || 'N/A',
                    projectId: property.projectId || 'N/A',
                    leadContactName: leadUser.name || 'N/A',
                    ...metadata
                }
            });
        });

        await Promise.all(notificationPromises);
    } catch (error) {
        logError('Error creating notification', error, { leadId, notificationType });
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

        const lead = await leadModal.findById(leadId).populate('userId', 'name').select('_id userId propertyId').lean();
        if (!lead) {
            return res.status(404).json({ success: false, message: "Lead not found" });
        }

        const validActivityTypes = ['phone_call', 'whatsapp', 'email', 'visit', 'follow_up', 'join_group', 'status_update', 'remark_update'];
        if (!validActivityTypes.includes(activityType)) {
            return res.status(400).json({
                success: false,
                message: `Invalid activity type. Must be one of: ${validActivityTypes.join(', ')}`
            });
        }

        const activityData = {
            leadId,
            activityType,
            performedBy,
            performedByName,
            description: description || '',
            metadata: {}
        };

        if (activityType === 'follow_up' && nextFollowUpDate) {
            activityData.nextFollowUpDate = new Date(nextFollowUpDate);
        }

        if (activityType === 'visit') {
            if (visitDate) activityData.visitDate = new Date(visitDate);
            if (visitTime) activityData.visitTime = visitTime;
        }

        const activity = await LeadActivity.create(activityData);

        if (activityType === 'follow_up' && nextFollowUpDate) {
            await leadModal.updateOne(
                { _id: leadId },
                { scheduleDate: new Date(nextFollowUpDate) }
            );
        }

        if (activityType === 'visit') {
            await leadModal.updateOne(
                { _id: leadId },
                { visitStatus: 'visited' }
            );
        }

        const leadUser = lead?.userId || {};

        let notificationTitle = '';
        let notificationMessage = '';
        let notificationMetadata = {};

        if (activityType === 'phone_call') {
            notificationTitle = 'Call Activity';
            notificationMessage = `Call By ${performedByName}`;
            notificationMetadata = { activityDescription: description || '' };
        } else if (activityType === 'whatsapp') {
            notificationTitle = 'WhatsApp Message';
            notificationMessage = `WhatsApp Message on ${leadUser.name || 'Lead'}`;
            notificationMetadata = { activityDescription: description || '' };
        } else if (activityType === 'follow_up') {
            notificationTitle = 'Follow-up Reminder';
            notificationMessage = 'This is a reminder for the upcoming follow-up regarding:';
            notificationMetadata = {
                nextFollowUpDate: nextFollowUpDate ? new Date(nextFollowUpDate) : null,
                activityDescription: description || ''
            };
        } else if (activityType === 'email') {
            notificationTitle = 'Email Activity';
            notificationMessage = `Email sent by ${performedByName}`;
            notificationMetadata = { activityDescription: description || '' };
        } else if (activityType === 'visit') {
            notificationTitle = 'Visit Activity';
            notificationMessage = `Visit scheduled by ${performedByName}`;
            notificationMetadata = {
                visitDate: visitDate ? new Date(visitDate) : null,
                visitTime: visitTime || null
            };
        }

        if (notificationTitle && notificationMessage) {
            await createNotification(
                leadId,
                activityType,
                performedByName,
                performedBy,
                notificationTitle,
                notificationMessage,
                notificationMetadata
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

        const validStatuses = [
            'lead_received',
            'interested',
            'no_response_dnp',
            'unable_to_contact',
            'call_back_scheduled',
            'demo_discussion_ongoing',
            'site_visit_coordination',
            'site_visit_confirmed',
            'commercial_negotiation',
            'deal_closed',
            'declined_interest',
            'does_not_meet_requirements',
            'pending',
            'approved',
            'rejected'
        ];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
            });
        }

        const lead = await leadModal.findById(leadId).select('status').lean();
        if (!lead) {
            return res.status(404).json({ success: false, message: "Lead not found" });
        }

        const oldStatus = lead.status;

        const updatedLead = await leadModal.findByIdAndUpdate(
            leadId,
            {
                status,
                ...(remark ? { message: remark } : {})
            },
            { new: true }
        ).select('status message').lean();

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

        const leadForNotification = await leadModal.findById(leadId).populate('userId', 'name').lean();
        const leadUser = leadForNotification?.userId || {};

        await createNotification(
            leadId,
            'status_update',
            performedByName,
            performedBy,
            'Status Update',
            `Status updated from ${oldStatus} to ${status} for ${leadUser.name || 'Lead'}`,
            {
                oldStatus,
                newStatus: status,
                activityDescription: remark || ''
            }
        );

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

        const lead = await leadModal.findById(leadId).select('message').lean();
        if (!lead) {
            return res.status(404).json({ success: false, message: "Lead not found" });
        }

        const oldRemark = lead.message || '';

        const updatedLead = await leadModal.findByIdAndUpdate(
            leadId,
            { message: remark || '' },
            { new: true }
        ).select('message').lean();

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

        const lead = await leadModal.findById(leadId).select('_id').lean();
        if (!lead) {
            return res.status(404).json({ success: false, message: "Lead not found" });
        }

        const activities = await LeadActivity.find({ leadId })
            .populate('performedBy', 'name email phone profileImage')
            .sort({ activityDate: -1 })
            .lean();

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
        const roles = await Role.find().sort({ createdAt: -1 });

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

        if (!name || !email || !password || !phone || !role) {
            return res.status(400).json({
                success: false,
                message: "All fields are required"
            });
        }

        const nameParts = name.trim().split(' ');
        const firstName = nameParts[0];
        const lastName = nameParts.slice(1).join(' ') || 'NA';

        if (!email.includes('@')) {
            return res.status(400).json({
                success: false,
                message: "Invalid email format"
            });
        }

        const blockedDomains = [
            'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
            'live.com', 'msn.com', 'aol.com', 'icloud.com', 'mail.com',
            'protonmail.com', 'yandex.com', 'zoho.com', 'rediffmail.com',
            'inbox.com', 'gmx.com'
        ];

        const emailDomain = email.split('@')[1]?.toLowerCase().trim();
        if (blockedDomains.includes(emailDomain)) {
            return res.status(400).json({
                success: false,
                message: "Personal email addresses are not allowed."
            });
        }

        const exists = await User.findOne({ email: email.toLowerCase() }).lean();
        if (exists) {
            return res.status(400).json({
                success: false,
                message: "Email already exists"
            });
        }

        const roleExists = await Role.findById(role).lean();
        if (!roleExists) {
            return res.status(400).json({
                success: false,
                message: "Invalid role"
            });
        }

        const user = await User.create({
            firstName,
            lastName,
            email: email.toLowerCase().trim(),
            password,
            phoneNumber: phone,
            countryCode: '+91',
            role
        });

        const smsResult = await sendPasswordSMS(
            phone,
            '+91',
            password,
            `${user.firstName} ${user.lastName}`
        );

        if (!smsResult.success) {
            console.error('❌ SMS failed:', smsResult.error);
        }

        await user.populate('role', 'name permissions');

        return res.status(201).json({
            success: true,
            message: "User created successfully & password sent via SMS",
            data: {
                _id: user._id,
                name: `${user.firstName} ${user.lastName}`,
                email: user.email,
                phone: user.phoneNumber,
                role: user.role,
                createdAt: user.createdAt
            }
        });

    } catch (error) {
        console.error('Create user error:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Error creating user"
        });
    }
};
// ===================== GET ALL USERS =====================
exports.getAllAssignUsers = async (req, res) => {
    try {
        const users = await User.find()
            .sort({ createdAt: -1 })
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

        if (email) {
            if (!email.includes('@')) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid email format"
                });
            }

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

            if (blockedDomains.includes(emailDomain)) {
                return res.status(400).json({
                    success: false,
                    message: "Personal email addresses are not allowed. Please use a business/domain email address."
                });
            }

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

        if (role) {
            const roleExists = await Role.findById(role).select('_id name').lean();
            if (!roleExists) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid role"
                });
            }
        }

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
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

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

        const formattedRecentLeads = recentLeads.map(lead => {
            const property = lead.propertyId || {};
            const user = lead.userId || {};

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

        const formattedTopProjects = topProjects.map(project => ({
            id: project._id,
            projectName: project.projectName || 'N/A',
            image: project.image || null,
            leadCount: project.leadCount || 0,
            newLeads: project.newLeads || 0,
            newLeadsFormatted: `${project.newLeads || 0} New Leads`
        }));

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

        const salesTeamPerformance = await Promise.all(salesTeamMembers.map(async (member) => {
            const totalLeads = await leadModal.countDocuments({
                $or: [
                    { relationshipManagerId: member._id },
                    { updatedBy: member._id }
                ],
                isStatus: true
            });

            const contactedLeads = await leadModal.countDocuments({
                $or: [
                    { relationshipManagerId: member._id },
                    { updatedBy: member._id }
                ],
                isStatus: true,
                visitStatus: { $in: ['visited', 'follow_up'] }
            });

            const leadContactedPercentage = totalLeads > 0
                ? Math.round((contactedLeads / totalLeads) * 100)
                : 0;

            const responseTime = '6H';

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
                overview: {
                    totalDevelopers,
                    liveProjects,
                    totalLeads,
                    totalBookingsThisMonth
                },
                recentLeads: formattedRecentLeads,
                topPerformingProjects: formattedTopProjects,
                salesTeamPerformance: salesTeamPerformance,
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

        if (req.user.roleName?.toLowerCase() === 'user') {
            filter.userId = req.user.userId;
        }

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
            .sort({ createdAt: -1 })
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

// ===================== CRM DASHBOARD API =====================
// @desc    Get CRM Dashboard with KPIs, Today's Follow Ups, and Lead List with Filtering & Sorting
// @route   GET /api/admin/crm-dashboard
// @access  Private (Admin/Agent)
exports.getCRMDashboard = async (req, res, next) => {
    try {
        const userId = req.user.userId;
        const {
            dateRange = 'past_24_hours', // past_24_hours, past_7_days, past_30_days
            sortBy = 'newest_first', // newest_first, oldest_first, name_asc, name_desc
            page = 1,
            limit = 10
        } = req.query;

        const userProperties = await Property.find({
            $or: [
                { relationshipManager: userId },
                { leadDistributionAgents: userId }
            ],
            isStatus: true
        }).select('_id').lean();

        const propertyIds = userProperties.map(p => p._id);

        const now = new Date();
        let dateFilter = {};

        if (dateRange === 'past_24_hours') {
            const startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            dateFilter.createdAt = { $gte: startDate };
        } else if (dateRange === 'past_7_days') {
            const startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            dateFilter.createdAt = { $gte: startDate };
        } else if (dateRange === 'past_30_days') {
            const startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            dateFilter.createdAt = { $gte: startDate };
        }

        const leadFilter = {
            isStatus: true,
            ...(propertyIds.length > 0 ? { propertyId: { $in: propertyIds } } : {})
        };

        if (propertyIds.length === 0) {
            return res.json({
                success: true,
                message: "CRM Dashboard data fetched",
                data: {
                    kpis: {
                        leadsReceived: 0,
                        leadsContacted: 0,
                        leadsContactedPercentage: 0,
                        responseTime: "0H"
                    },
                    todaysFollowUps: [],
                    leads: [],
                    pagination: {
                        total: 0,
                        page: parseInt(page),
                        limit: parseInt(limit),
                        totalPages: 0
                    }
                }
            });
        }

        const [totalLeads, contactedLeads, allLeadsForResponseTime] = await Promise.all([
            leadModal.countDocuments({
                ...leadFilter,
                ...dateFilter
            }),
            leadModal.countDocuments({
                ...leadFilter,
                ...dateFilter,
                visitStatus: { $in: ['visited', 'follow_up'] }
            }),
            leadModal.find({
                ...leadFilter,
                ...dateFilter
            }).select('createdAt relationshipManagerId').lean()
        ]);

        let avgResponseTimeHours = 0;
        if (contactedLeads > 0) {
            const contactedLeadIds = await leadModal.find({
                ...leadFilter,
                ...dateFilter,
                visitStatus: { $in: ['visited', 'follow_up'] }
            }).select('_id createdAt').lean();

            const leadIds = contactedLeadIds.map(l => l._id);

            if (leadIds.length > 0) {
                const firstContacts = await LeadActivity.aggregate([
                    {
                        $match: {
                            leadId: { $in: leadIds },
                            activityType: { $in: ['phone_call', 'whatsapp', 'email', 'visit'] }
                        }
                    },
                    {
                        $group: {
                            _id: '$leadId',
                            firstContactDate: { $min: '$activityDate' }
                        }
                    }
                ]);

                let totalResponseTime = 0;
                let count = 0;

                for (const contact of firstContacts) {
                    const lead = contactedLeadIds.find(l => l._id.toString() === contact._id.toString());
                    if (lead) {
                        const responseTimeMs = new Date(contact.firstContactDate) - new Date(lead.createdAt);
                        const responseTimeHours = responseTimeMs / (1000 * 60 * 60);
                        if (responseTimeHours > 0) {
                            totalResponseTime += responseTimeHours;
                            count++;
                        }
                    }
                }

                avgResponseTimeHours = count > 0 ? Math.round(totalResponseTime / count) : 0;
            }
        }

        const leadsContactedPercentage = totalLeads > 0
            ? Math.round((contactedLeads / totalLeads) * 100)
            : 0;

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const followUpActivities = await LeadActivity.find({
            activityType: 'follow_up',
            nextFollowUpDate: {
                $gte: today,
                $lt: tomorrow
            }
        })
            .populate({
                path: 'leadId',
                match: {
                    ...leadFilter,
                    isStatus: true
                },
                populate: [
                    {
                        path: 'userId',
                        select: 'name email phoneNumber countryCode profileImage'
                    },
                    {
                        path: 'propertyId',
                        select: 'projectName location'
                    }
                ]
            })
            .sort({ nextFollowUpDate: 1 })
            .lean();

        const todaysFollowUps = followUpActivities
            .filter(activity => activity.leadId !== null)
            .map(activity => {
                const lead = activity.leadId;
                const user = lead.userId || {};
                const property = lead.propertyId || {};

                const followUpDate = new Date(activity.nextFollowUpDate);
                const day = followUpDate.getDate();
                const month = followUpDate.toLocaleDateString('en-IN', { month: 'long' });
                const year = followUpDate.getFullYear();
                const time = followUpDate.toLocaleTimeString('en-IN', {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: true
                });
                const formattedDate = `${day} ${month}, ${year}, ${time}`;

                let formattedSource = lead.source || 'origin';
                if (property.location) {
                    formattedSource = `${property.location} - ${formattedSource.charAt(0).toUpperCase() + formattedSource.slice(1)}.`;
                }

                let formattedPhone = 'N/A';
                if (user.phoneNumber) {
                    const countryCode = user.countryCode || '+91';
                    const phoneDigits = user.phoneNumber.replace(/\s/g, '');
                    if (phoneDigits.length === 10) {
                        formattedPhone = `${countryCode} ${phoneDigits.slice(0, 3)} ${phoneDigits.slice(3, 6)} ${phoneDigits.slice(6)}`;
                    } else {
                        formattedPhone = `${countryCode} ${user.phoneNumber}`;
                    }
                }

                return {
                    _id: lead._id,
                    clientName: user.name || 'N/A',
                    phoneNumber: formattedPhone,
                    profileImage: user.profileImage || null,
                    projectName: property.projectName || 'N/A',
                    location: property.location || 'N/A',
                    date: formattedDate,
                    dueTime: followUpDate.toLocaleTimeString('en-IN', {
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: true
                    }),
                    source: formattedSource,
                    createdAt: lead.createdAt,
                    updatedAt: lead.updatedAt
                };
            });

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const totalLeadsCount = await leadModal.countDocuments({
            ...leadFilter,
            ...dateFilter
        });

        let leads = [];

        if (sortBy === 'name_asc' || sortBy === 'name_desc') {
            const sortOrder = sortBy === 'name_asc' ? 1 : -1;

            const leadsAggregation = await leadModal.aggregate([
                { $match: { ...leadFilter, ...dateFilter } },
                {
                    $lookup: {
                        from: 'users',
                        localField: 'userId',
                        foreignField: '_id',
                        as: 'user'
                    }
                },
                { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
                {
                    $addFields: {
                        userName: { $ifNull: ['$user.name', ''] }
                    }
                },
                { $sort: { userName: sortOrder } },
                { $skip: skip },
                { $limit: parseInt(limit) },
                {
                    $lookup: {
                        from: 'properties',
                        localField: 'propertyId',
                        foreignField: '_id',
                        as: 'property'
                    }
                },
                { $unwind: { path: '$property', preserveNullAndEmptyArrays: true } }
            ]);

            leads = leadsAggregation.map(item => ({
                _id: item._id,
                userId: item.user || null,
                propertyId: item.property || null,
                createdAt: item.createdAt,
                date: item.date,
                source: item.source,
                visitStatus: item.visitStatus,
                status: item.status,
                updatedAt: item.updatedAt
            }));
        } else {
            let sortCriteria = {};
            if (sortBy === 'newest_first') {
                sortCriteria = { createdAt: -1 };
            } else if (sortBy === 'oldest_first') {
                sortCriteria = { createdAt: 1 };
            } else {
                sortCriteria = { createdAt: -1 };
            }

            leads = await leadModal.find({
                ...leadFilter,
                ...dateFilter
            })
                .populate({
                    path: 'userId',
                    select: 'name email phoneNumber countryCode profileImage'
                })
                .populate({
                    path: 'propertyId',
                    select: 'projectName location'
                })
                .sort(sortCriteria)
                .skip(skip)
                .limit(parseInt(limit))
                .lean();
        }

        const formattedLeads = leads.map(lead => {
            const user = lead.userId || {};
            const property = lead.propertyId || {};

            const leadDate = new Date(lead.createdAt || lead.date);
            const day = leadDate.getDate();
            const month = leadDate.toLocaleDateString('en-IN', { month: 'long' });
            const year = leadDate.getFullYear();
            const time = leadDate.toLocaleTimeString('en-IN', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: true
            });
            const formattedDate = `${day} ${month}, ${year}, ${time}`;

            let formattedSource = lead.source || 'origin';
            if (property.location) {
                formattedSource = `${property.location} - ${formattedSource.charAt(0).toUpperCase() + formattedSource.slice(1)}.`;
            }

            let formattedPhone = 'N/A';
            if (user.phoneNumber) {
                const countryCode = user.countryCode || '+91';
                const phoneDigits = user.phoneNumber.replace(/\s/g, '');
                if (phoneDigits.length === 10) {
                    formattedPhone = `${countryCode} ${phoneDigits.slice(0, 3)} ${phoneDigits.slice(3, 6)} ${phoneDigits.slice(6)}`;
                } else {
                    formattedPhone = `${countryCode} ${user.phoneNumber}`;
                }
            }

            return {
                _id: lead._id,
                clientName: user.name || 'N/A',
                phoneNumber: formattedPhone,
                profileImage: user.profileImage || null,
                projectName: property.projectName || 'N/A',
                location: property.location || 'N/A',
                date: formattedDate,
                source: formattedSource,
                visitStatus: lead.visitStatus || 'not_visited',
                status: lead.status || 'pending',
                createdAt: lead.createdAt,
                updatedAt: lead.updatedAt
            };
        });

        logInfo('CRM Dashboard data fetched', {
            userId,
            dateRange,
            sortBy,
            totalLeads,
            contactedLeads,
            todaysFollowUpsCount: todaysFollowUps.length
        });

        res.json({
            success: true,
            message: "CRM Dashboard data fetched successfully",
            data: {
                kpis: {
                    leadsReceived: totalLeads,
                    leadsContacted: contactedLeads,
                    leadsContactedPercentage: leadsContactedPercentage,
                    responseTime: `${avgResponseTimeHours}H`
                },
                todaysFollowUps: todaysFollowUps,
                leads: formattedLeads,
                pagination: {
                    total: totalLeadsCount,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    totalPages: Math.ceil(totalLeadsCount / parseInt(limit))
                }
            }
        });

    } catch (error) {
        logError('Error fetching CRM dashboard', error, { userId: req.user?.userId });
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===================== GET NOTIFICATIONS =====================
// @desc    Get notifications for logged-in user, grouped by date
// @route   GET /api/admin/notifications
// @access  Private (Admin/Agent)
exports.getNotifications = async (req, res, next) => {
    try {
        const userId = req.user.userId;

        const userProperties = await Property.find({
            $or: [
                { relationshipManager: userId },
                { leadDistributionAgents: userId }
            ],
            isStatus: true
        }).select('_id').lean();

        const propertyIds = userProperties.map(p => p._id);

        const filter = {
            userId,
            ...(propertyIds.length > 0 ? { propertyId: { $in: propertyIds } } : {})
        };

        if (propertyIds.length === 0) {
            return res.json({
                success: true,
                message: "Notifications fetched",
                data: []
            });
        }

        const notifications = await Notification.find(filter)
            .populate({
                path: 'leadId',
                select: 'userId propertyId',
                populate: {
                    path: 'userId',
                    select: 'name'
                }
            })
            .populate({
                path: 'propertyId',
                select: 'projectName projectId'
            })
            .populate({
                path: 'sourceId',
                select: 'name'
            })
            .sort({ createdAt: -1 })
            .lean();

        const getDateLabel = (date) => {
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);

            const notificationDate = new Date(date);
            notificationDate.setHours(0, 0, 0, 0);

            if (notificationDate.getTime() === today.getTime()) {
                return 'Today';
            } else if (notificationDate.getTime() === yesterday.getTime()) {
                return 'Yesterday';
            } else {
                return notificationDate.toLocaleDateString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric'
                });
            }
        };

        const grouped = {};

        for (const notification of notifications) {
            const dateLabel = getDateLabel(notification.createdAt);

            if (!grouped[dateLabel]) {
                grouped[dateLabel] = [];
            }

            const now = new Date();
            const notificationTime = new Date(notification.createdAt);
            const diffMs = now - notificationTime;
            const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
            const diffDays = Math.floor(diffHours / 24);

            let timeAgo = '';
            if (diffHours < 1) {
                const diffMins = Math.floor(diffMs / (1000 * 60));
                timeAgo = diffMins <= 1 ? 'Just now' : `${diffMins} minutes ago`;
            } else if (diffHours < 24) {
                timeAgo = `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`;
            } else {
                timeAgo = `${diffDays} ${diffDays === 1 ? 'day' : 'days'} ago`;
            }

            let formattedMessage = notification.message;
            let formattedTitle = notification.title;

            if (notification.notificationType === 'follow_up') {
                const property = notification.propertyId || {};
                const nextFollowUpDate = notification.metadata?.nextFollowUpDate;

                formattedMessage = `This is a reminder for the upcoming follow-up regarding:\nProject: ${property.projectName || 'N/A'}\nProject ID: ${property.projectId || 'N/A'}\nNext Follow-up Date: ${nextFollowUpDate ? new Date(nextFollowUpDate).toLocaleDateString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                }) : 'N/A'}`;
            } else if (notification.notificationType === 'phone_call') {
                formattedMessage = `Call By ${notification.source}`;
            } else if (notification.notificationType === 'whatsapp') {
                const leadUser = notification.leadId?.userId || {};
                formattedMessage = `WhatsApp Message on ${leadUser.name || 'Lead'}`;
            }

            grouped[dateLabel].push({
                _id: notification._id,
                title: formattedTitle,
                message: formattedMessage,
                source: notification.source,
                timeAgo,
                isRead: notification.isRead,
                notificationType: notification.notificationType,
                metadata: notification.metadata,
                createdAt: notification.createdAt,
                updatedAt: notification.updatedAt
            });
        }

        const sortedLabels = Object.keys(grouped).sort((a, b) => {
            if (a === 'Today') return -1;
            if (b === 'Today') return 1;
            if (a === 'Yesterday') return -1;
            if (b === 'Yesterday') return 1;
            return b.localeCompare(a);
        });

        const formattedData = sortedLabels.map(label => ({
            dateLabel: label,
            notifications: grouped[label]
        }));

        logInfo('Notifications fetched', {
            userId,
            notificationCount: notifications.length,
            groupCount: formattedData.length
        });

        res.json({
            success: true,
            message: 'Notifications fetched successfully',
            data: formattedData
        });

    } catch (error) {
        logError('Error fetching notifications', error, { userId: req.user?.userId });
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===================== MARK ALL NOTIFICATIONS AS READ =====================
// @desc    Mark all notifications as read for logged-in user
// @route   PUT /api/admin/notifications/mark-all-read
// @access  Private (Admin/Agent)
exports.markAllNotificationsAsRead = async (req, res, next) => {
    try {
        const userId = req.user.userId;

        const userProperties = await Property.find({
            $or: [
                { relationshipManager: userId },
                { leadDistributionAgents: userId }
            ],
            isStatus: true
        }).select('_id').lean();

        const propertyIds = userProperties.map(p => p._id);

        const filter = {
            userId,
            isRead: false,
            ...(propertyIds.length > 0 ? { propertyId: { $in: propertyIds } } : {})
        };

        const result = await Notification.updateMany(
            filter,
            { isRead: true }
        );

        logInfo('All notifications marked as read', {
            userId,
            updatedCount: result.modifiedCount
        });

        res.json({
            success: true,
            message: 'All notifications marked as read',
            data: {
                updatedCount: result.modifiedCount
            }
        });

    } catch (error) {
        logError('Error marking all notifications as read', error, { userId: req.user?.userId });
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===================== SCHEDULE FOLLOW-UP =====================
// @desc    Schedule or update follow-up date for a lead
// @route   POST /api/admin/lead/:leadId/follow-up
// @access  Private (Admin/Agent)
exports.scheduleFollowUp = async (req, res, next) => {
    try {
        const { leadId } = req.params;
        const { followUpDate, followUpTime, description } = req.body;
        const performedBy = req.user.userId;
        const performedByName = req.user.name || 'Admin';

        const lead = await leadModal.findById(leadId)
            .populate('propertyId', 'projectName projectId')
            .populate('userId', 'name')
            .lean();

        if (!lead) {
            return res.status(404).json({ success: false, message: "Lead not found" });
        }

        let parsedFollowUpDate = null;
        if (followUpDate) {
            parsedFollowUpDate = new Date(followUpDate);
            if (isNaN(parsedFollowUpDate.getTime())) {
                return res.status(400).json({ success: false, message: "Invalid follow-up date format" });
            }

            if (followUpTime) {
                const [hours, minutes] = followUpTime.split(':');
                parsedFollowUpDate.setHours(parseInt(hours) || 0, parseInt(minutes) || 0, 0, 0);
            }
        }

        await leadModal.findByIdAndUpdate(
            leadId,
            { scheduleDate: parsedFollowUpDate || null },
            { new: true }
        );

        const activityDescription = parsedFollowUpDate
            ? `Follow up scheduled for ${parsedFollowUpDate.toLocaleDateString('en-IN', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            })}${description ? `. ${description}` : ''}`
            : `Follow up cleared${description ? `. ${description}` : ''}`;

        const activity = await LeadActivity.create({
            leadId,
            activityType: 'follow_up',
            performedBy,
            performedByName,
            description: activityDescription,
            nextFollowUpDate: parsedFollowUpDate,
            metadata: {
                followUpTime: followUpTime || null,
                description: description || ''
            }
        });

        const property = lead.propertyId || {};
        const leadUser = lead.userId || {};

        if (parsedFollowUpDate) {
            await createNotification(
                leadId,
                'follow_up',
                performedByName,
                performedBy,
                'Follow-up Reminder',
                `This is a reminder for the upcoming follow-up regarding:\nProject: ${property.projectName || 'N/A'}\nProject ID: ${property.projectId || 'N/A'}\nNext Follow-up Date: ${parsedFollowUpDate.toLocaleDateString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                })}`,
                {
                    nextFollowUpDate: parsedFollowUpDate,
                    activityDescription: description || ''
                }
            );
        }

        logInfo('Follow-up scheduled', {
            leadId,
            followUpDate: parsedFollowUpDate,
            performedBy
        });

        res.json({
            success: true,
            message: parsedFollowUpDate ? "Follow-up scheduled successfully" : "Follow-up cleared successfully",
            data: {
                activityId: activity._id,
                followUpDate: parsedFollowUpDate,
                activityDate: activity.activityDate
            }
        });

    } catch (error) {
        logError('Error scheduling follow-up', error, {
            leadId: req.params.leadId,
            performedBy: req.user?.userId
        });
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===================== CALL NOW =====================
// @desc    Record a call activity for a lead
// @route   POST /api/admin/lead/:leadId/call
// @access  Private (Admin/Agent)
exports.callNow = async (req, res, next) => {
    try {
        const { leadId } = req.params;
        const { description } = req.body;
        const performedBy = req.user.userId;
        const performedByName = req.user.name || 'Admin';

        const lead = await leadModal.findById(leadId)
            .populate('userId', 'name')
            .lean();

        if (!lead) {
            return res.status(404).json({ success: false, message: "Lead not found" });
        }

        const leadUser = lead.userId || {};
        const activityDescription = `Phone call made to ${leadUser.name || 'lead'}${description ? `. ${description}` : ''}`;

        const activity = await LeadActivity.create({
            leadId,
            activityType: 'phone_call',
            performedBy,
            performedByName,
            description: activityDescription,
            metadata: {
                description: description || ''
            }
        });

        await createNotification(
            leadId,
            'phone_call',
            performedByName,
            performedBy,
            'Call Activity',
            `Call By ${performedByName}`,
            {
                activityDescription: description || ''
            }
        );

        logInfo('Call activity recorded', {
            leadId,
            performedBy,
            activityId: activity._id
        });

        res.json({
            success: true,
            message: "Call activity recorded successfully",
            data: {
                activityId: activity._id,
                activityType: activity.activityType,
                activityDate: activity.activityDate
            }
        });

    } catch (error) {
        logError('Error recording call activity', error, {
            leadId: req.params.leadId,
            performedBy: req.user?.userId
        });
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===================== SEND WHATSAPP =====================
// @desc    Record a WhatsApp message activity for a lead
// @route   POST /api/admin/lead/:leadId/whatsapp
// @access  Private (Admin/Agent)
exports.sendWhatsApp = async (req, res, next) => {
    try {
        const { leadId } = req.params;
        const { description } = req.body;
        const performedBy = req.user.userId;
        const performedByName = req.user.name || 'Admin';

        const lead = await leadModal.findById(leadId)
            .populate('userId', 'name')
            .lean();

        if (!lead) {
            return res.status(404).json({ success: false, message: "Lead not found" });
        }

        const leadUser = lead.userId || {};
        const activityDescription = `WhatsApp message sent to ${leadUser.name || 'lead'}${description ? `. ${description}` : ''}`;

        const activity = await LeadActivity.create({
            leadId,
            activityType: 'whatsapp',
            performedBy,
            performedByName,
            description: activityDescription,
            metadata: {
                description: description || ''
            }
        });

        await createNotification(
            leadId,
            'whatsapp',
            performedByName,
            performedBy,
            'WhatsApp Message',
            `WhatsApp Message on ${leadUser.name || 'Lead'}`,
            {
                activityDescription: description || ''
            }
        );

        logInfo('WhatsApp activity recorded', {
            leadId,
            performedBy,
            activityId: activity._id
        });

        res.json({
            success: true,
            message: "WhatsApp activity recorded successfully",
            data: {
                activityId: activity._id,
                activityType: activity.activityType,
                activityDate: activity.activityDate
            }
        });

    } catch (error) {
        logError('Error recording WhatsApp activity', error, {
            leadId: req.params.leadId,
            performedBy: req.user?.userId
        });
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===================== GET CRM PROFILE =====================
// @desc    Get CRM user profile
// @route   GET /api/admin/crm/profile
// @access  Private (Admin/Agent)
exports.getCRMProfile = async (req, res, next) => {
    try {
        const userId = req.user.userId;

        const user = await User.findById(userId)
            .select('-password')
            .populate('role', 'name roleName')
            .lean();

        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        const profileData = {
            _id: user._id,
            firstName: user.firstName || '',
            lastName: user.lastName || '',
            name: user.name || `${user.firstName || ''} ${user.lastName || ''}`.trim(),
            email: user.email || '',
            phoneNumber: user.phoneNumber || '',
            countryCode: user.countryCode || '+91',
            profileImage: user.profileImage || null,
            pincode: user.pincode || '',
            city: user.city || '',
            state: user.state || '',
            country: user.country || 'India',
            role: user.role || null,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt
        };

        logInfo('CRM profile fetched', { userId });

        res.json({
            success: true,
            message: "Profile fetched successfully",
            data: profileData
        });

    } catch (error) {
        logError('Error fetching CRM profile', error, { userId: req.user?.userId });
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===================== UPDATE CRM PROFILE =====================
// @desc    Update CRM user profile
// @route   PUT /api/admin/crm/profile
// @access  Private (Admin/Agent)
exports.updateCRMProfile = async (req, res, next) => {
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

        const currentUser = await User.findById(userId).select('email phoneNumber').lean();
        if (!currentUser) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        const updates = {};

        if (firstName) updates.firstName = firstName.trim();
        if (lastName) updates.lastName = lastName.trim();
        if (pincode) updates.pincode = pincode.trim();
        if (city) updates.city = city.trim();
        if (state) updates.state = state.trim();
        if (country) updates.country = country.trim();

        if (email && email !== currentUser.email) {
            const emailExists = await User.findOne({ email: email.toLowerCase().trim() });
            if (emailExists) {
                return res.status(400).json({
                    success: false,
                    message: "Email already exists"
                });
            }
            updates.email = email.toLowerCase().trim();
        }

        if (phoneNumber) {
            const phoneRegex = /^[0-9]{10}$/;
            if (!phoneRegex.test(phoneNumber)) {
                return res.status(400).json({
                    success: false,
                    message: "Phone number must be 10 digits"
                });
            }
            updates.phoneNumber = phoneNumber;
        }

        if (countryCode) {
            updates.countryCode = countryCode.trim();
        }

        if (req.file) {
            try {
                const profileImage = await uploadToS3(req.file, 'users/profile');
                updates.profileImage = profileImage;
            } catch (uploadError) {
                logError('Error uploading profile image', uploadError, { userId });
                return res.status(500).json({
                    success: false,
                    message: "Failed to upload profile image"
                });
            }
        } else if (req.body.profileImage) {
            updates.profileImage = req.body.profileImage;
        }

        const updatedUser = await User.findByIdAndUpdate(
            userId,
            updates,
            { new: true, runValidators: true }
        )
            .select('-password')
            .populate('role', 'name roleName')
            .lean();

        const profileData = {
            _id: updatedUser._id,
            firstName: updatedUser.firstName || '',
            lastName: updatedUser.lastName || '',
            name: updatedUser.name || `${updatedUser.firstName || ''} ${updatedUser.lastName || ''}`.trim(),
            email: updatedUser.email || '',
            phoneNumber: updatedUser.phoneNumber || '',
            countryCode: updatedUser.countryCode || '+91',
            profileImage: updatedUser.profileImage || null,
            pincode: updatedUser.pincode || '',
            city: updatedUser.city || '',
            state: updatedUser.state || '',
            country: updatedUser.country || 'India',
            role: updatedUser.role || null,
            createdAt: updatedUser.createdAt,
            updatedAt: updatedUser.updatedAt
        };

        logInfo('CRM profile updated', { userId, updatedFields: Object.keys(updates) });

        res.json({
            success: true,
            message: "Profile updated successfully",
            data: profileData
        });

    } catch (error) {
        logError('Error updating CRM profile', error, { userId: req.user?.userId });
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===================== BLOG MANAGEMENT SECTION =====================

// ===================== CREATE BLOG =====================
// @desc    Create a new blog post
// @route   POST /api/admin/blog
// @access  Private (Admin)
exports.createBlog = async (req, res, next) => {
    try {
        const {
            title,
            subtitle,
            category,
            tags,
            content,
            isPublished
        } = req.body;

        const author = req.user.userId;
        const authorName = req.user.name || 'Admin';

        if (!title || !content) {
            return res.status(400).json({
                success: false,
                message: 'Title and content are required'
            });
        }

        let tagsArray = [];
        if (tags) {
            if (typeof tags === 'string') {
                try {
                    tagsArray = JSON.parse(tags);
                } catch {
                    tagsArray = tags.split(',').map(tag => tag.trim()).filter(tag => tag);
                }
            } else if (Array.isArray(tags)) {
                tagsArray = tags;
            }
        }

        let bannerImageUrl = null;
        if (req.files?.bannerImage && req.files.bannerImage[0]) {
            try {
                bannerImageUrl = await uploadToS3(req.files.bannerImage[0], 'blogs/banner');
            } catch (uploadError) {
                logError('Error uploading banner image', uploadError);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to upload banner image'
                });
            }
        } else if (req.body.bannerImage) {
            bannerImageUrl = req.body.bannerImage;
        }

        let galleryImageUrls = [];
        if (req.files?.galleryImages && req.files.galleryImages.length > 0) {
            try {
                const uploadPromises = req.files.galleryImages.map(file =>
                    uploadToS3(file, 'blogs/gallery')
                );
                galleryImageUrls = await Promise.all(uploadPromises);
            } catch (uploadError) {
                logError('Error uploading gallery images', uploadError);
            }
        } else if (req.body.galleryImages) {
            const galleryImagesData = typeof req.body.galleryImages === 'string'
                ? JSON.parse(req.body.galleryImages)
                : req.body.galleryImages;
            if (Array.isArray(galleryImagesData)) {
                galleryImageUrls = galleryImagesData;
            }
        }

        const slug = title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '');

        let finalSlug = slug;
        const existingBlog = await Blog.findOne({ slug: finalSlug }).lean();
        if (existingBlog) {
            finalSlug = `${slug}-${Date.now()}`;
        }

        const blog = await Blog.create({
            title,
            subtitle: subtitle || '',
            category: category || '',
            author,
            authorName,
            tags: tagsArray,
            bannerImage: bannerImageUrl,
            galleryImages: galleryImageUrls,
            content,
            slug: finalSlug,
            isPublished: isPublished === 'true' || isPublished === true
        });

        logInfo('Blog created successfully', {
            blogId: blog._id,
            title: blog.title,
            author
        });

        res.status(201).json({
            success: true,
            message: 'Blog created successfully',
            data: {
                blog
            }
        });

    } catch (error) {
        logError('Error creating blog', error, { userId: req.user?.userId });
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===================== GET ALL BLOGS (Admin) =====================
// @desc    Get all blogs for admin with search and pagination
// @route   GET /api/admin/blogs
// @access  Private (Admin)
exports.getAllBlogs = async (req, res, next) => {
    try {
        const { search, page = 1, limit = 10 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const filter = { isStatus: true };

        if (search) {
            filter.$or = [
                { title: { $regex: search, $options: 'i' } },
                { authorName: { $regex: search, $options: 'i' } },
                { category: { $regex: search, $options: 'i' } },
                { tags: { $in: [new RegExp(search, 'i')] } }
            ];
        }

        const total = await Blog.countDocuments(filter);

        const blogs = await Blog.find(filter)
            .populate('author', 'name email profileImage')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .lean();

        const formattedBlogs = blogs.map(blog => ({
            _id: blog._id,
            title: blog.title,
            subtitle: blog.subtitle || '',
            category: blog.category || '',
            author: blog.authorName || blog.author?.name || 'Admin',
            authorId: blog.author?._id || blog.author,
            tags: blog.tags || [],
            bannerImage: blog.bannerImage || null,
            date: new Date(blog.createdAt).toLocaleDateString('en-IN', {
                day: 'numeric',
                month: 'short',
                year: 'numeric'
            }),
            isPublished: blog.isPublished,
            views: blog.views || 0,
            createdAt: blog.createdAt,
            updatedAt: blog.updatedAt
        }));

        logInfo('Blogs fetched for admin', { total, page, limit });

        res.json({
            success: true,
            message: 'Blogs fetched successfully',
            data: formattedBlogs,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total / parseInt(limit))
            }
        });

    } catch (error) {
        logError('Error fetching blogs', error, { userId: req.user?.userId });
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===================== GET BLOG BY ID (Admin) =====================
// @desc    Get single blog by ID for admin
// @route   GET /api/admin/blog/:id
// @access  Private (Admin)
exports.getBlogById = async (req, res, next) => {
    try {
        const { id } = req.params;

        const blog = await Blog.findById(id)
            .populate('author', 'name email profileImage')
            .lean();

        if (!blog) {
            return res.status(404).json({
                success: false,
                message: 'Blog not found'
            });
        }

        res.json({
            success: true,
            message: 'Blog fetched successfully',
            data: blog
        });

    } catch (error) {
        logError('Error fetching blog', error, { blogId: req.params.id });
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===================== UPDATE BLOG =====================
// @desc    Update a blog post
// @route   PUT /api/admin/blog/:id
// @access  Private (Admin)
exports.updateBlog = async (req, res, next) => {
    try {
        const { id } = req.params;
        const {
            title,
            subtitle,
            category,
            tags,
            content,
            isPublished
        } = req.body;

        const existingBlog = await Blog.findById(id);
        if (!existingBlog) {
            return res.status(404).json({
                success: false,
                message: 'Blog not found'
            });
        }

        const updates = {};

        if (title) {
            updates.title = title;
            const slug = title
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/(^-|-$)/g, '');

            const slugExists = await Blog.findOne({ slug, _id: { $ne: id } }).lean();
            updates.slug = slugExists ? `${slug}-${Date.now()}` : slug;
        }

        if (subtitle !== undefined) updates.subtitle = subtitle;
        if (category !== undefined) updates.category = category;
        if (content !== undefined) updates.content = content;
        if (isPublished !== undefined) {
            updates.isPublished = isPublished === 'true' || isPublished === true;
        }

        if (tags !== undefined) {
            let tagsArray = [];
            if (typeof tags === 'string') {
                try {
                    tagsArray = JSON.parse(tags);
                } catch {
                    tagsArray = tags.split(',').map(tag => tag.trim()).filter(tag => tag);
                }
            } else if (Array.isArray(tags)) {
                tagsArray = tags;
            }
            updates.tags = tagsArray;
        }

        if (req.files?.bannerImage && req.files.bannerImage[0]) {
            try {
                updates.bannerImage = await uploadToS3(req.files.bannerImage[0], 'blogs/banner');
            } catch (uploadError) {
                logError('Error uploading banner image', uploadError);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to upload banner image'
                });
            }
        } else if (req.body.bannerImage !== undefined) {
            updates.bannerImage = req.body.bannerImage || null;
        }

        if (req.files?.galleryImages && req.files.galleryImages.length > 0) {
            try {
                const uploadPromises = req.files.galleryImages.map(file =>
                    uploadToS3(file, 'blogs/gallery')
                );
                const newGalleryImages = await Promise.all(uploadPromises);
                updates.galleryImages = [...(existingBlog.galleryImages || []), ...newGalleryImages];
            } catch (uploadError) {
                logError('Error uploading gallery images', uploadError);
            }
        } else if (req.body.galleryImages !== undefined) {
            const galleryImagesData = typeof req.body.galleryImages === 'string'
                ? JSON.parse(req.body.galleryImages)
                : req.body.galleryImages;
            if (Array.isArray(galleryImagesData)) {
                updates.galleryImages = galleryImagesData;
            }
        }

        const updatedBlog = await Blog.findByIdAndUpdate(
            id,
            updates,
            { new: true, runValidators: true }
        )
            .populate('author', 'name email profileImage')
            .lean();

        logInfo('Blog updated successfully', {
            blogId: id,
            updatedFields: Object.keys(updates)
        });

        res.json({
            success: true,
            message: 'Blog updated successfully',
            data: updatedBlog
        });

    } catch (error) {
        logError('Error updating blog', error, { blogId: req.params.id });
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===================== DELETE BLOG =====================
// @desc    Delete a blog post (soft delete)
// @route   DELETE /api/admin/blog/:id
// @access  Private (Admin)
exports.deleteBlog = async (req, res, next) => {
    try {
        const { id } = req.params;

        const blog = await Blog.findById(id);
        if (!blog) {
            return res.status(404).json({
                success: false,
                message: 'Blog not found'
            });
        }

        blog.isStatus = false;
        await blog.save();

        logInfo('Blog deleted successfully', { blogId: id });

        res.json({
            success: true,
            message: 'Blog deleted successfully'
        });

    } catch (error) {
        logError('Error deleting blog', error, { blogId: req.params.id });
        res.status(500).json({ success: false, message: error.message });
    }
};
