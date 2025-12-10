const leadModal = require('../models/leadModal');
const Property = require('../models/property');
const UserPropertyActivity = require('../models/userPropertyActivity');
const UserSearchHistory = require('../models/userSearchHistory');

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
        const { propertyId, visitDate, visitTime, message } = req.body;

        const property = await Property.findById(propertyId);

        if (!property) {
            return res.json({ success: false, message: "Property not found" });
        }

        const existingActivity = await UserPropertyActivity.findOne({
            userId,
            propertyId,
            activityType: "visited"
        });

        if (existingActivity) {
            existingActivity.visitedAt = new Date();
            existingActivity.visitDate = visitDate;
            existingActivity.visitTime = visitTime;
            await existingActivity.save();
        } else {
            await UserPropertyActivity.create({
                userId,
                propertyId,
                activityType: "visited",
                visitedAt: new Date(),
                visitDate: new Date(visitDate),
                visitTime,
            });
        }

        await leadModal.create({
            userId,
            propertyId,
            rmEmail: property.rmEmail,
            rmPhone: property.rmPhone,
            message
        });

        res.json({
            success: true,
            message: "Visit registered & lead created successfully"
        });

    } catch (error) {
        res.json({ success: false, message: error.message });
    }
};

exports.addSearchHistory = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { searchQuery, location, budgetMin, budgetMax } = req.body;

        // Duplicate check
        const existing = await UserSearchHistory.findOne({
            userId,
            searchQuery,
            location,
            budgetMin,
            budgetMax
        });

        if (existing) {
            return res.json({
                success: true,
                message: 'Search already exists',
                data: existing
            });
        }

        // Add new search
        const newSearch = await UserSearchHistory.create({
            userId,
            searchQuery,
            location,
            budgetMin,
            budgetMax
        });

        res.json({ success: true, message: 'Search added successfully', data: newSearch });

    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
