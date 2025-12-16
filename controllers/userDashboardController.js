const leadModal = require('../models/leadModal');
const Property = require('../models/property');
const UserPropertyActivity = require('../models/userPropertyActivity');
const UserSearchHistory = require('../models/userSearchHistory');
const ContactPreferences = require('../models/userContactDetails');
const { logInfo, logError } = require('../utils/logger');

exports.getUserDashboard = async (req, res) => {
    try {
        const userId = req.user.userId;

        // Optimize: Run all count queries in parallel
        const [totalViewed, totalFavorited, totalVisited] = await Promise.all([
            UserPropertyActivity.countDocuments({ userId, activityType: "viewed" }),
            UserPropertyActivity.countDocuments({ userId, activityType: "favorite" }),
            UserPropertyActivity.countDocuments({ userId, activityType: "visited" })
        ]);

        logInfo('User dashboard data fetched', { userId, totalViewed, totalFavorited, totalVisited });
        res.status(200).json({
            success: true,
            message: "Dashboard data fetched",
            data: {
                totalViewed,
                totalFavorited,
                totalVisited
            }
        });

    } catch (error) {
        logError('Error fetching user dashboard', error, { userId: req.user.userId });
        res.status(500).json({
            success: false,
            message: "Error fetching dashboard",
            error: error.message
        });
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

        logInfo('Property view added in dashboard', { userId, propertyId });
        res.json({ success: true, message: "View added successfully" });

    } catch (error) {
        logError('Error adding property view in dashboard', error, { userId, propertyId });
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
            logInfo('Property removed from favorites in dashboard', { userId, propertyId });
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

        logInfo('Property added to favorites in dashboard', { userId, propertyId });
        res.json({ success: true, message: "Added to favorites" });

    } catch (error) {
        logError('Error toggling favorite property in dashboard', error, { userId, propertyId });
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

        res.json({
            success: true,
            message: "Visit registered & lead created successfully"
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.registerUpdateVisit = async (req, res) => {
    try {
        const { leadId } = req.params;
        const userId = req.user.userId;
        const { visitDate, visitTime, source } = req.body;

        const updated = await leadModal.findByIdAndUpdate(
            leadId,
            { visitDate, visitTime, source, updatedBy: userId },
            { new: true }
        );

        res.json({
            success: true,
            message: "Lead updated successfully",
            data: updated
        });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
};

exports.getSearchHistory = async (req, res) => {
    try {
        const userId = req.user.userId;

        // Optimize query with lean() and limit results
        const searches = await UserSearchHistory.find({ userId })
            .sort({ createdAt: -1 })
            .lean()
            .limit(100); // Limit to last 100 searches for performance

        const grouped = {};
        for (const s of searches) {
            const date = s.createdAt.toLocaleDateString();

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
                        ...(s.searchQuery ? { "property.projectName": { $regex: s.searchQuery, $options: "i" } } : {}),
                        ...(s.location ? { "property.location": s.location } : {}),
                        ...(s.developer ? { "property.developer": new mongoose.Types.ObjectId(s.developer) } : {})
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

            if (!grouped[date]) grouped[date] = [];
            grouped[date].push({ ...s._doc, topProperties });
        }

        logInfo('Search history fetched', { userId, searchCount: searches.length });
        res.json({ success: true, message: 'Search history fetched', data: grouped });
    } catch (error) {
        logError('Error fetching search history', error, { userId });
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.saveContactPreferences = async (req, res) => {
    try {
        const userId = req.user._id;

        const allowedFields = [
            "fullAddress",
            "mobile",
            "city",
            "state",
            "pinCode",
            "country",
            "preferredLocations",
            "budgetMin",
            "budgetMax",
            "preferredHouseType",
            "preferredDirection",
            "preferredFloor"
        ];

        // Check if body contains only allowed fields
        const invalidFields = Object.keys(req.body).filter(
            (key) => !allowedFields.includes(key)
        );

        if (invalidFields.length > 0) {
            return res.status(400).json({
                success: false,
                message: `Invalid fields found: ${invalidFields.join(", ")}`
            });
        }

        // Build final data object
        const data = {
            ...req.body,
            email: req.user.email
        };

        // Additional validations
        if (data.preferredLocations && !Array.isArray(data.preferredLocations)) {
            return res.status(400).json({
                success: false,
                message: "preferredLocations must be an array"
            });
        }

        if (data.preferredHouseType && !Array.isArray(data.preferredHouseType)) {
            return res.status(400).json({
                success: false,
                message: "preferredHouseType must be an array"
            });
        }

        if (data.preferredDirection && !Array.isArray(data.preferredDirection)) {
            return res.status(400).json({
                success: false,
                message: "preferredDirection must be an array"
            });
        }

        if (data.preferredFloor && !Array.isArray(data.preferredFloor)) {
            return res.status(400).json({
                success: false,
                message: "preferredFloor must be an array"
            });
        }

        const existing = await ContactPreferences.findOne({ userId });

        let result;

        if (existing) {
            result = await ContactPreferences.findOneAndUpdate(
                { userId },
                data,
                { new: true }
            );
        } else {
            data.userId = userId;
            result = await ContactPreferences.create(data);
        }

        return res.status(200).json({
            success: true,
            message: existing ? "Preferences Updated" : "Preferences Saved",
            data: result
        });

    } catch (error) {
        console.error(error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// GET DATA
exports.getContactPreferences = async (req, res) => {
    try {
        const userId = req.user._id;

        const result = await ContactPreferences.findOne({ userId }).lean();

        logInfo('Contact preferences fetched', { userId });
        return res.status(200).json({
            success: true,
            data: result
        });

    } catch (error) {
        logError('Error fetching contact preferences', error, { userId });
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// Viewed Properties
exports.getViewedProperties = async (req, res) => {
    try {
        const userId = req.user.userId;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const total = await UserPropertyActivity.countDocuments({
            userId,
            activityType: "viewed"
        });

        const data = await UserPropertyActivity.find({
            userId,
            activityType: "viewed"
        })
            .populate("propertyId")
            .sort({ lastViewedAt: -1 })
            .skip(skip)
            .limit(limit);

        logInfo('Viewed properties fetched', { userId, total, page, limit });
        res.json({
            success: true,
            message: "Viewed properties fetched",
            data,
            pagination: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        logError('Error fetching viewed properties', error, { userId });
        res.json({ success: false, message: error.message });
    }
};

// Favorited Properties
exports.getFavoritedProperties = async (req, res) => {
    try {
        const userId = req.user.userId;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const total = await UserPropertyActivity.countDocuments({
            userId,
            activityType: "favorite"
        });

        // Optimize query with lean() and select only needed fields
        const data = await UserPropertyActivity.find({
            userId,
            activityType: "favorite"
        })
            .populate("propertyId", 'projectName location developer')
            .select('propertyId favoritedAt')
            .sort({ favoritedAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        logInfo('Favorited properties fetched', { userId, total, page, limit });
        res.json({
            success: true,
            message: "Favorited properties fetched",
            data,
            pagination: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        logError('Error fetching favorited properties', error, { userId });
        res.json({ success: false, message: error.message });
    }
};

// Visited Properties
exports.getVisitedProperties = async (req, res) => {
    try {
        const userId = req.user.userId;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Upcoming visits (today or future)
        const upcomingTotal = await UserPropertyActivity.countDocuments({
            userId,
            activityType: "visited",
            visitDate: { $gte: today }
        });

        // Optimize: Run queries in parallel and use lean()
        const [upcoming, completedTotal, completed] = await Promise.all([
            UserPropertyActivity.find({
                userId,
                activityType: "visited",
                visitDate: { $gte: today }
            })
                .populate("propertyId", 'projectName location developer')
                .select('propertyId visitDate visitTime')
                .sort({ visitDate: 1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            UserPropertyActivity.countDocuments({
                userId,
                activityType: "visited",
                visitDate: { $lt: today }
            }),
            UserPropertyActivity.find({
                userId,
                activityType: "visited",
                visitDate: { $lt: today }
            })
                .populate("propertyId", 'projectName location developer')
                .select('propertyId visitDate visitTime')
                .sort({ visitDate: -1 })
                .skip(skip)
                .limit(limit)
                .lean()
        ]);

        logInfo('Visited properties fetched', { userId, upcomingTotal, completedTotal, page, limit });
        res.json({
            success: true,
            message: "Visited properties fetched",
            data: {
                upcoming,
                completed
            },
            pagination: {
                upcoming: {
                    total: upcomingTotal,
                    page,
                    limit,
                    totalPages: Math.ceil(upcomingTotal / limit)
                },
                completed: {
                    total: completedTotal,
                    page,
                    limit,
                    totalPages: Math.ceil(completedTotal / limit)
                }
            }
        });

    } catch (error) {
        logError('Error fetching visited properties', error, { userId });
        res.json({ success: false, message: error.message });
    }
};
