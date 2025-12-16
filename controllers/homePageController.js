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
