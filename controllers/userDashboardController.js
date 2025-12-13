const leadModal = require('../models/leadModal');
const Property = require('../models/property');
const UserPropertyActivity = require('../models/userPropertyActivity');
const UserSearchHistory = require('../models/userSearchHistory');
const ContactPreferences = require('../models/userContactDetails');

exports.getUserDashboard = async (req, res) => {
    try {
        const userId = req.user.userId;

        const totalViewed = await UserPropertyActivity.countDocuments({
            userId,
            activityType: "viewed"
        });

        const totalFavorited = await UserPropertyActivity.countDocuments({
            userId,
            activityType: "favorite"
        });

        const totalVisited = await UserPropertyActivity.countDocuments({
            userId,
            activityType: "visited"
        });

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
        const { propertyId, visitDate, visitTime ,source = "origin" } = req.body;

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

        const searches = await UserSearchHistory.find({ userId }).sort({ createdAt: -1 });

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

        res.json({ success: true, message: 'Search history fetched', data: grouped });
    } catch (error) {
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

        const result = await ContactPreferences.findOne({ userId });

        return res.status(200).json({
            success: true,
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

        const data = await UserPropertyActivity.find({
            userId,
            activityType: "favorite"
        })
            .populate("propertyId")
            .sort({ favoritedAt: -1 })
            .skip(skip)
            .limit(limit);

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

        const upcoming = await UserPropertyActivity.find({
            userId,
            activityType: "visited",
            visitDate: { $gte: today }
        })
            .populate("propertyId")
            .sort({ visitDate: 1 })
            .skip(skip)
            .limit(limit);

        // Completed visits (past)
        const completedTotal = await UserPropertyActivity.countDocuments({
            userId,
            activityType: "visited",
            visitDate: { $lt: today }
        });

        const completed = await UserPropertyActivity.find({
            userId,
            activityType: "visited",
            visitDate: { $lt: today }
        })
            .populate("propertyId")
            .sort({ visitDate: -1 })
            .skip(skip)
            .limit(limit);

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
        res.json({ success: false, message: error.message });
    }
};
