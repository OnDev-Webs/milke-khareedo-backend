const Developer = require('../models/developer');
const Property = require('../models/property');
const { uploadToS3 } = require("../utils/s3");

// Create property
exports.createProperty = async (req, res, next) => {
    try {
        let { 
            projectName, developer, location, projectSize, landParcel,
            possessionDate, developerPrice, groupPrice, minGroupMembers,
            reraId, possessionStatus, description, configurations,
            highlights, amenities, layouts, connectivity, 
            relationshipManager, leadDistributionAgents, status 
        } = req.body;

        if (!developer) {
            return res.status(400).json({ success: false, message: "Developer is required" });
        }

        const dev = await Developer.findById(developer);
        if (!dev) {
            return res.status(400).json({ success: false, message: "Invalid developer selected" });
        }

        // ------------------- Safe JSON parsing -------------------
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

        let uploadedImages = [];
        let uploadedLayouts = [];
        let uploadedQrImage = null;

        // Upload property images
        if (req.files?.images) {
            const imagesFiles = Array.isArray(req.files.images) ? req.files.images : [req.files.images];
            for (let file of imagesFiles) {
                const url = await uploadToS3(file);
                uploadedImages.push({ url, isCover: false, order: uploadedImages.length + 1 });
            }
        }

        // Upload layouts
        if (req.files?.layouts) {
            const layoutFiles = Array.isArray(req.files.layouts) ? req.files.layouts : [req.files.layouts];
            for (let i = 0; i < layoutFiles.length; i++) {
                const url = await uploadToS3(layoutFiles[i]);
                uploadedLayouts.push({
                    image: url,
                    carpetArea: layouts[i]?.carpetArea || null,
                    builtUpArea: layouts[i]?.builtUpArea || null,
                    price: layouts[i]?.price || null,
                    availabilityStatus: layouts[i]?.availabilityStatus || "Available"
                });
            }
        }

        if (req.files?.reraQrImage) {
            const qrFile = Array.isArray(req.files.reraQrImage) ? req.files.reraQrImage[0] : req.files.reraQrImage;
            uploadedQrImage = await uploadToS3(qrFile);
        }

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
            reraQrImage: uploadedQrImage ? uploadedQrImage : req.body.reraQrImage,
            possessionStatus,
            description,
            configurations,
            images: uploadedImages.length > 0 ? uploadedImages : safeJSON(req.body.images) || [],
            highlights,
            amenities,
            layouts: uploadedLayouts.length > 0 ? uploadedLayouts : safeJSON(req.body.layouts) || [],
            connectivity,
            relationshipManager,
            leadDistributionAgents,
            status
        });

        res.status(201).json({
            success: true,
            message: "Property created successfully",
            data: property,
        });

    } catch (error) {
        console.log(error);
        next(error);
    }
};

// Get all properties
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

        res.json({
            success: true,
            data: properties,
            total,
            page,
            totalPages: Math.ceil(total / limit),
            count: properties.length,
        });

    } catch (error) {
        next(error);
    }
};

// Get single property
exports.getPropertyById = async (req, res, next) => {
    try {
        const property = await Property.findById(req.params.id)
            .populate('developer')
            .populate('relationshipManager')
            .populate('leadDistributionAgents');

        if (!property)
            return res.status(404).json({ success: false, message: 'Property not found' });

        res.json({ success: true, data: property });
    } catch (error) {
        next(error);
    }
};

// Update property
exports.updateProperty = async (req, res, next) => {
    try {
        const allowedFields = [
            'projectName', 'developer', 'location', 'projectSize', 'landParcel',
            'possessionDate', 'developerPrice', 'groupPrice', 'minGroupMembers',
            'reraId', 'reraQrImage', 'possessionStatus', 'description',
            'configurations', 'images', 'highlights', 'amenities', 'layouts',
            'connectivity', 'relationshipManager', 'leadDistributionAgents', 'status'
        ];

        const updates = {};

        allowedFields.forEach(field => {
            if (req.body[field] !== undefined) updates[field] = req.body[field];
        });

        // 🔥 Here is S3 Upload Logic
        const uploadedImages = req.files?.images?.map(file => file.location) || [];
        const uploadedLayouts = req.files?.layouts?.map(file => file.location) || [];
        const uploadedQrImage = req.files?.reraQrImage?.[0]?.location || null;

        // 👉 Update Images (merge OR replace)
        if (uploadedImages.length > 0) {
            updates.images = uploadedImages; 
        }

        // 👉 Update Layouts
        if (uploadedLayouts.length > 0) {
            updates.layouts = uploadedLayouts;
        }

        // 👉 Update QR
        if (uploadedQrImage) {
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
        next(error);
    }
};


// Delete property
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
