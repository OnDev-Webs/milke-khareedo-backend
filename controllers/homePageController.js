const leadModal = require('../models/leadModal');
const Property = require('../models/property');
const UserPropertyActivity = require('../models/userPropertyActivity');
const UserSearchHistory = require('../models/userSearchHistory');
const mongoose = require('mongoose');
const { logInfo, logError } = require('../utils/logger');

exports.getTopVisitedProperties = async (req, res, next) => {
    try {
        let { page = 1, limit = 10, developer, projectName, possessionStatus, location, unitType } = req.query;
        page = parseInt(page);
        limit = parseInt(limit);
        const skip = (page - 1) * limit;

        const tabFilter = {};
        if (developer) tabFilter["property.developer"] = new mongoose.Types.ObjectId(developer);
        if (projectName) tabFilter["property.projectName"] = { $regex: projectName, $options: "i" };
        if (possessionStatus) tabFilter["property.possessionStatus"] = possessionStatus;
        if (location) tabFilter["property.location"] = location;
        if (unitType) tabFilter["property.configurations"] = { $elemMatch: { unitType: unitType } };

        const result = await UserPropertyActivity.aggregate([
            { $match: { activityType: "visited" } },

            {
                $group: {
                    _id: "$propertyId",
                    visitCount: { $sum: 1 },
                    lastVisitedAt: { $max: "$visitedAt" }
                }
            },

            { $sort: { visitCount: -1, lastVisitedAt: -1 } },

            {
                $lookup: {
                    from: "properties",
                    localField: "_id",
                    foreignField: "_id",
                    as: "property"
                }
            },

            { $unwind: { path: "$property", preserveNullAndEmptyArrays: false } },

            ...(Object.keys(tabFilter).length ? [{ $match: tabFilter }] : []),

            {
                $facet: {
                    data: [
                        { $skip: skip },
                        { $limit: limit }
                    ],
                    totalCount: [
                        { $count: "count" }
                    ]
                }
            }
        ]);

        const data = result[0].data;
        const total = result[0].totalCount[0]?.count || 0;

        logInfo('Top visited properties fetched', { total, page, limit, filters: { developer, projectName, possessionStatus, location, unitType } });
        res.json({
            success: true,
            type: "TOP_VISITED",
            data,
            pagination: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        logError('Error fetching top visited properties', error);
        next(error);
    }
};

// controllers/homePageController.js
exports.getTopPropertyById = async (req, res, next) => {
    try {
        const { id } = req.params;

        // Validate ObjectId
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: "Invalid property ID" });
        }

        // Find property by ID - optimize with lean() and select specific fields
        const property = await Property.findById(id)
            .populate('developer', 'name')
            .populate('relationshipManager', 'name')
            .populate('leadDistributionAgents', 'name')
            .lean();

        if (!property) {
            logInfo('Property not found', { propertyId: id });
            return res.status(404).json({ success: false, message: "Property not found" });
        }

        logInfo('Property fetched by ID', { propertyId: id });
        res.json({
            success: true,
            data: property
        });

    } catch (error) {
        logError('Error fetching property by ID', error, { propertyId: id });
        next(error);
    }
};

exports.addViewedProperty = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { propertyId } = req.body;

        const existing = await UserPropertyActivity.findOne({
            userId,
            propertyId,
            activityType: "viewed"
        }).lean();

        if (existing) {
            await UserPropertyActivity.updateOne(
                { _id: existing._id },
                { lastViewedAt: new Date() }
            );
        } else {
            await UserPropertyActivity.create({
                userId,
                propertyId,
                activityType: "viewed",
                lastViewedAt: new Date()
            });
        }

        logInfo('Property view added', { userId, propertyId });
        res.json({ success: true, message: "View added successfully" });

    } catch (error) {
        logError('Error adding property view', error, { userId, propertyId });
        res.json({ success: false, message: error.message });
    }
};

exports.toggleFavoriteProperty = async (req, res) => {
    try {
        const { propertyId } = req.body;
        const userId = req.user.userId;

        const existing = await UserPropertyActivity.findOne({
            userId,
            propertyId,
            activityType: "favorite"
        }).lean();

        if (existing) {
            await UserPropertyActivity.deleteOne({ _id: existing._id });
            logInfo('Property removed from favorites', { userId, propertyId });
            return res.json({
                success: true,
                message: "Removed from favorites"
            });
        }

        await UserPropertyActivity.create({
            userId,
            propertyId,
            activityType: "favorite",
            favoritedAt: new Date()
        });

        logInfo('Property added to favorites', { userId, propertyId });
        res.json({ success: true, message: "Added to favorites" });

    } catch (error) {
        logError('Error toggling favorite property', error, { userId, propertyId });
        res.json({ success: false, message: error.message });
    }
};

exports.registerVisit = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { propertyId, visitDate, visitTime, source = "origin" } = req.body;

        // Validate property - optimize with lean() and select only needed fields
        const property = await Property.findById(propertyId)
            .populate('relationshipManager', 'email phone')
            .select('relationshipManager')
            .lean();
        if (!property) {
            logInfo('Property not found for visit registration', { propertyId });
            return res.status(404).json({ success: false, message: "Property not found" });
        }

        // Parse visitDate
        let parsedVisitDate = visitDate ? new Date(visitDate) : null;
        if (visitDate && isNaN(parsedVisitDate.getTime())) {
            return res.status(400).json({ success: false, message: "Invalid visitDate format" });
        }

        // Create or update visit activity - optimize with updateOne
        const existingActivity = await UserPropertyActivity.findOne({
            userId,
            propertyId,
            activityType: "visited"
        }).lean();

        if (existingActivity) {
            const updateData = {
                visitedAt: new Date(),
                visitTime,
                source: source || "origin",
                updatedBy: userId
            };
            // Only update visitDate if provided to prevent overwriting existing values
            if (parsedVisitDate) {
                updateData.visitDate = parsedVisitDate;
            }
            await UserPropertyActivity.updateOne(
                { _id: existingActivity._id },
                updateData
            );
        } else {
            await UserPropertyActivity.create({
                userId,
                propertyId,
                activityType: "visited",
                visitedAt: new Date(),
                visitDate: parsedVisitDate,
                visitTime,
                source: source || "origin",
                updatedBy: userId,
                isStatus: true
            });
        }

        // Create lead (minimal fields only)
        await leadModal.create({
            userId,
            propertyId,
            relationshipManagerId: property.relationshipManager?._id,
            rmEmail: property.relationshipManager?.email || "",
            rmPhone: property.relationshipManager?.phone || "",
            isStatus: true,
            source: source || "origin",
            updatedBy: userId
        });

        logInfo('Visit registered and lead created', { userId, propertyId, source });
        res.json({
            success: true,
            message: "Visit registered & lead created successfully"
        });

    } catch (error) {
        logError('Error registering visit', error, { userId, propertyId });
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.addSearchHistory = async (req, res, next) => {
    try {
        const userId = req.user?.userId;
        const { searchQuery, location, developer, projectName } = req.body;

        const trimmedSearchQuery = searchQuery?.trim();
        const trimmedProjectName = projectName?.trim();
        const trimmedLocation = location?.trim();

        let searchData = null;

        if (userId) {
            // Duplicate check
            const existing = await UserSearchHistory.findOne({
                userId,
                searchQuery: trimmedSearchQuery,
                projectName: trimmedProjectName,
                ...(trimmedLocation ? { location: trimmedLocation } : {}),
                ...(developer ? { developer: new mongoose.Types.ObjectId(developer) } : {})
            });

            if (existing) {
                searchData = existing;
            } else {
                // Save new search
                searchData = await UserSearchHistory.create({
                    userId,
                    searchQuery: trimmedSearchQuery,
                    location: trimmedLocation,
                    developer,
                    projectName: trimmedProjectName
                });
            }
        }

        const topProperties = await UserPropertyActivity.aggregate([
            { $match: { activityType: "visited" } },
            {
                $lookup: {
                    from: "properties",
                    localField: "propertyId",
                    foreignField: "_id",
                    as: "property"
                }
            },
            { $unwind: "$property" },
            {
                $match: {
                    ...(trimmedSearchQuery || trimmedProjectName
                        ? { "property.projectName": { $regex: trimmedSearchQuery || trimmedProjectName, $options: "i" } }
                        : {}),
                    ...(trimmedLocation ? { "property.location": trimmedLocation } : {}),
                    ...(developer ? { "property.developer": new mongoose.Types.ObjectId(developer) } : {})
                }
            },
            {
                $group: {
                    _id: "$propertyId",
                    visitCount: { $sum: 1 },
                    lastVisitedAt: { $max: "$visitedAt" },
                    property: { $first: "$property" }
                }
            },
            { $sort: { visitCount: -1, lastVisitedAt: -1 } }
        ]);

        logInfo('Search history added', {
            userId,
            hasSearchData: !!searchData,
            topPropertiesCount: topProperties.length
        });
        res.json({
            success: true,
            message: userId ? "Search added successfully" : "Search executed successfully",
            searchData,
            topProperties
        });

    } catch (error) {
        logError('Error adding search history', error, { userId });
        next(error);
    }
};

// @desc    Compare multiple properties
// @route   POST /api/home/compare
// @access  Public (or Private if needed)
exports.compareProperties = async (req, res, next) => {
    try {
        const { propertyIds } = req.body;

        // Validate input
        if (!propertyIds || !Array.isArray(propertyIds)) {
            return res.status(400).json({
                success: false,
                message: 'propertyIds must be an array'
            });
        }

        // Limit to 3 properties for comparison (as per UI)
        if (propertyIds.length === 0 || propertyIds.length > 3) {
            return res.status(400).json({
                success: false,
                message: 'Please provide 1 to 3 property IDs for comparison'
            });
        }

        // Validate all IDs are valid ObjectIds
        const invalidIds = propertyIds.filter(id => !mongoose.Types.ObjectId.isValid(id));
        if (invalidIds.length > 0) {
            return res.status(400).json({
                success: false,
                message: `Invalid property IDs: ${invalidIds.join(', ')}`
            });
        }

        // Fetch all properties in parallel with optimized queries
        const properties = await Property.find({
            _id: { $in: propertyIds },
            isStatus: true
        })
            .populate('developer', 'developerName')
            .populate('relationshipManager', 'name email phone')
            .select('projectName developer location configurations images layouts possessionDate possessionStatus projectId developerPrice groupPrice')
            .lean();

        // Check if all properties were found
        if (properties.length !== propertyIds.length) {
            const foundIds = properties.map(p => p._id.toString());
            const missingIds = propertyIds.filter(id => !foundIds.includes(id));
            return res.status(404).json({
                success: false,
                message: `Properties not found: ${missingIds.join(', ')}`
            });
        }

        // Format properties for comparison
        const formattedProperties = properties.map(property => {
            // Calculate budget range from configurations
            const prices = property.configurations
                .map(config => {
                    const priceStr = config.price || '0';
                    // Remove currency symbols, spaces, and convert to number
                    // Handle both lakhs and crores format
                    let priceNum = parseFloat(priceStr.replace(/[₹,\s]/g, '')) || 0;

                    // If price is in lakhs (less than 1000000), convert to rupees
                    if (priceStr.toLowerCase().includes('lakh') || priceStr.toLowerCase().includes('l')) {
                        priceNum = priceNum * 100000;
                    }
                    // If price is in crores (contains 'cr' or 'crore'), convert to rupees
                    else if (priceStr.toLowerCase().includes('cr') || priceStr.toLowerCase().includes('crore')) {
                        priceNum = priceNum * 10000000;
                    }

                    return priceNum;
                })
                .filter(price => price > 0);

            // Also check root level developerPrice and groupPrice
            if (property.developerPrice) {
                let devPrice = parseFloat(property.developerPrice.replace(/[₹,\s]/g, '')) || 0;
                if (property.developerPrice.toLowerCase().includes('lakh') || property.developerPrice.toLowerCase().includes('l')) {
                    devPrice = devPrice * 100000;
                } else if (property.developerPrice.toLowerCase().includes('cr') || property.developerPrice.toLowerCase().includes('crore')) {
                    devPrice = devPrice * 10000000;
                }
                if (devPrice > 0) prices.push(devPrice);
            }

            const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
            const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;

            // Calculate area range from configurations
            const areas = property.configurations
                .map(config => {
                    const carpetArea = parseFloat(config.carpetArea?.replace(/[sqft,\s]/gi, '') || '0');
                    const builtUpArea = parseFloat(config.builtUpArea?.replace(/[sqft,\s]/gi, '') || '0');
                    return Math.max(carpetArea, builtUpArea);
                })
                .filter(area => area > 0);

            const minArea = areas.length > 0 ? Math.min(...areas) : 0;
            const maxArea = areas.length > 0 ? Math.max(...areas) : 0;

            // Get unique BHK types from configurations
            const unitTypes = [...new Set(property.configurations.map(config => config.unitType).filter(Boolean))];

            // Get cover image or first image
            const coverImage = property.images?.find(img => img.isCover)?.url || property.images?.[0]?.url || null;

            // Get floor plan images (layouts)
            const floorPlans = property.layouts?.map(layout => ({
                image: layout.image,
                unitType: layout.configurationUnitType
            })) || [];

            // Format possession date
            let possessionDateFormatted = null;
            if (property.possessionDate) {
                const date = new Date(property.possessionDate);
                possessionDateFormatted = date.toLocaleDateString('en-IN', {
                    month: 'short',
                    year: 'numeric'
                });
            }

            return {
                id: property._id,
                projectId: property.projectId,
                projectName: property.projectName,
                developer: property.developer?.developerName || 'N/A',
                developerId: property.developer?._id || null,
                location: property.location,
                propertyType: 'Residential', // Based on UI, can be made dynamic if needed
                budget: {
                    min: minPrice,
                    max: maxPrice,
                    formatted: minPrice > 0 && maxPrice > 0
                        ? `₹ ${(minPrice / 10000000).toFixed(2)} Cr - ${(maxPrice / 10000000).toFixed(2)} Cr`
                        : 'Price on Request'
                },
                area: {
                    min: minArea,
                    max: maxArea,
                    formatted: minArea > 0 && maxArea > 0
                        ? `${minArea} - ${maxArea} sqft`
                        : 'Area on Request'
                },
                configurations: unitTypes,
                configurationsFormatted: unitTypes.join(', '),
                mainImage: coverImage,
                floorPlans: floorPlans,
                possessionDate: property.possessionDate,
                possessionDateFormatted: possessionDateFormatted,
                possessionStatus: property.possessionStatus || 'N/A',
                relationshipManager: property.relationshipManager ? {
                    id: property.relationshipManager._id,
                    name: property.relationshipManager.name,
                    email: property.relationshipManager.email,
                    phone: property.relationshipManager.phone
                } : null,
                // Include full configurations for detailed view if needed
                fullConfigurations: property.configurations
            };
        });

        logInfo('Properties compared', {
            propertyCount: formattedProperties.length,
            propertyIds: propertyIds
        });

        res.json({
            success: true,
            message: 'Properties fetched for comparison',
            data: formattedProperties,
            count: formattedProperties.length
        });

    } catch (error) {
        logError('Error comparing properties', error, { propertyIds: req.body.propertyIds });
        next(error);
    }
};
