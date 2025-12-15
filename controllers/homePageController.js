const leadModal = require('../models/leadModal');
const Property = require('../models/property');
const UserPropertyActivity = require('../models/userPropertyActivity');
const UserSearchHistory = require('../models/userSearchHistory');
const mongoose = require('mongoose');

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

        // Find property by ID
        const property = await Property.findById(id)
            .populate('developer', 'name')
            .populate('relationshipManager', 'name')
            .populate('leadDistributionAgents', 'name');

        if (!property) {
            return res.status(404).json({ success: false, message: "Property not found" });
        }

        res.json({
            success: true,
            data: property
        });

    } catch (error) {
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
        });

        if (existing) {
            existing.lastViewedAt = new Date();
            await existing.save();
        } else {
            await UserPropertyActivity.create({
                userId,
                propertyId,
                activityType: "viewed",
                lastViewedAt: new Date()
            });
        }

        res.json({ success: true, message: "View added successfully" });

    } catch (error) {
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
        });

        if (existing) {
            await existing.deleteOne();
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

        res.json({ success: true, message: "Added to favorites" });

    } catch (error) {
        res.json({ success: false, message: error.message });
    }
};

exports.registerVisit = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { propertyId, visitDate, visitTime, source = "origin" } = req.body;

        // Validate property
        const property = await Property.findById(propertyId).populate('relationshipManager');
        if (!property) {
            return res.status(404).json({ success: false, message: "Property not found" });
        }

        // Parse visitDate
        let parsedVisitDate = visitDate ? new Date(visitDate) : null;
        if (visitDate && isNaN(parsedVisitDate.getTime())) {
            return res.status(400).json({ success: false, message: "Invalid visitDate format" });
        }

        // Create or update visit activity
        const existingActivity = await UserPropertyActivity.findOne({
            userId,
            propertyId,
            activityType: "visited"
        });

        if (existingActivity) {
            existingActivity.visitedAt = new Date();
            if (parsedVisitDate) existingActivity.visitDate = parsedVisitDate;
            existingActivity.visitTime = visitTime;
            existingActivity.source = source || "origin";
            existingActivity.updatedBy = userId;
            await existingActivity.save();
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

        res.json({
            success: true,
            message: "Visit registered & lead created successfully"
        });

    } catch (error) {
        console.error(error);
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

        res.json({
            success: true,
            message: userId ? "Search added successfully" : "Search executed successfully",
            searchData, 
            topProperties
        });

    } catch (error) {
        next(error);
    }
};
